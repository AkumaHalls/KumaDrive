use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

type Result<T> = std::result::Result<T, KumaDriveError>;

#[derive(Error, Debug, Serialize)]
pub enum KumaDriveError {
    #[error("Falha ao acessar diretório de dados: {0}")]
    DataDir(String),
    #[error("Falha ao ler arquivo: {0}")]
    ReadFile(String),
    #[error("Falha ao escrever arquivo: {0}")]
    WriteFile(String),
    #[error("Falha ao serializar JSON: {0}")]
    JsonSerialize(String),
    #[error("Falha ao desserializar JSON: {0}")]
    JsonDeserialize(String),
    #[error("Arquivo não encontrado: {0}")]
    NotFound(String),
    #[error("Operação inválida: {0}")]
    InvalidOperation(String),
    #[error("Erro de criptografia: {0}")]
    Crypto(String),
    #[error("Erro de I/O: {0}")]
    Io(String),
}

impl From<KumaDriveError> for String {
    fn from(err: KumaDriveError) -> Self {
        err.to_string()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DirEntry {
    pub abs_path: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionData {
    pub session: Option<String>,
    pub phone: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupConfig {
    pub source_path: String,
    pub interval_minutes: u64,
    pub enabled: bool,
    pub exclude_patterns: Vec<String>,
    pub last_run: Option<i64>,
    pub next_run: Option<i64>,
}

fn get_vault_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app.path().app_data_dir().map_err(|e| KumaDriveError::DataDir(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| KumaDriveError::Io(e.to_string()))?;
    Ok(data_dir.join("kumadrive_vault.json"))
}

fn get_session_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app.path().app_data_dir().map_err(|e| KumaDriveError::DataDir(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| KumaDriveError::Io(e.to_string()))?;
    Ok(data_dir.join("kumadrive_session.json"))
}

fn get_backup_config_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app.path().app_data_dir().map_err(|e| KumaDriveError::DataDir(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| KumaDriveError::Io(e.to_string()))?;
    Ok(data_dir.join("kumadrive_backup_config.json"))
}

fn get_vault_state_log_path(app: &AppHandle) -> Result<PathBuf> {
    let data_dir = app.path().app_data_dir().map_err(|e| KumaDriveError::DataDir(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| KumaDriveError::Io(e.to_string()))?;
    Ok(data_dir.join("vault_state.log"))
}

/// Serializa todas as operações de leitura-modificação-escrita sobre os
/// arquivos de vault/sessão. Sem isso, dois `save_vault_value` concorrentes
/// leem o mesmo estado antigo e a última escrita apaga a chave da outra.
fn vault_io_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Escreve `contents` em `path` de forma atômica (arquivo temporário + rename).
/// Uma queda de energia ou disco cheio no meio da escrita deixa o arquivo
/// anterior intacto, em vez de um JSON truncado que descartaria silenciosamente
/// todas as credenciais armazenadas.
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)
        .map_err(|e| KumaDriveError::WriteFile(format!("write({}) falhou: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        KumaDriveError::WriteFile(format!("rename({} -> {}) falhou: {e}", tmp.display(), path.display()))
    })?;
    Ok(())
}

#[tauri::command]
async fn save_vault_value(app: AppHandle, key: String, value: String) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let vault_path = get_vault_path(&app)?;
    let mut data = if vault_path.exists() {
        let contents = std::fs::read_to_string(&vault_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&contents).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    data.insert(key, serde_json::Value::String(value));
    write_atomic(&vault_path, &serde_json::to_string(&data).unwrap())?;
    Ok(())
}

#[tauri::command]
async fn load_vault_value(app: AppHandle, key: String) -> Result<Option<String>> {
    let vault_path = get_vault_path(&app)?;
    if !vault_path.exists() { return Ok(None); }
    let contents = std::fs::read_to_string(&vault_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    if let Some(val) = data.get(&key) {
        if let Some(s) = val.as_str() {
            return Ok(Some(s.to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn delete_vault_value(app: AppHandle, key: String) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let vault_path = get_vault_path(&app)?;
    if !vault_path.exists() { return Ok(()); }
    let contents = std::fs::read_to_string(&vault_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let mut data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    data.remove(&key);
    write_atomic(&vault_path, &serde_json::to_string(&data).unwrap())?;
    Ok(())
}

#[tauri::command]
async fn quarantine_vault_value(app: AppHandle, key: String, backup_key: String) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let vault_path = get_vault_path(&app)?;
    if !vault_path.exists() { return Ok(()); }
    let contents = std::fs::read_to_string(&vault_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let mut data: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    if let Some(value) = data.remove(&key) {
        data.insert(backup_key, value);
    }
    write_atomic(&vault_path, &serde_json::to_string(&data).unwrap())?;
    Ok(())
}

#[tauri::command]
async fn save_session(app: AppHandle, session: String, phone: String) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let session_path = get_session_path(&app)?;
    let json = serde_json::json!({ "session": session, "phone": phone });
    write_atomic(&session_path, &json.to_string())?;
    Ok(())
}

#[tauri::command]
async fn load_session(app: AppHandle) -> Result<SessionData> {
    let session_path = get_session_path(&app)?;
    if !session_path.exists() { return Ok(SessionData { session: None, phone: None }); }
    let contents = std::fs::read_to_string(&session_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let parsed: SessionData = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    Ok(parsed)
}

#[tauri::command]
async fn clear_session(app: AppHandle) -> Result<()> {
    let session_path = get_session_path(&app)?;
    if session_path.exists() { std::fs::remove_file(&session_path).map_err(|e| KumaDriveError::WriteFile(e.to_string()))?; }
    Ok(())
}

#[tauri::command]
async fn clear_session_only(app: AppHandle) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let session_path = get_session_path(&app)?;
    if !session_path.exists() { return Ok(()); }
    let contents = std::fs::read_to_string(&session_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let mut parsed: serde_json::Value = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    if let Some(obj) = parsed.as_object_mut() { obj.insert("session".to_string(), serde_json::Value::Null); }
    write_atomic(&session_path, &parsed.to_string())?;
    Ok(())
}

static SCHEDULED_BACKUP_HANDLE: OnceLock<AsyncMutex<Option<tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();

fn handle_slot() -> &'static AsyncMutex<Option<tauri::async_runtime::JoinHandle<()>>> {
    SCHEDULED_BACKUP_HANDLE.get_or_init(|| AsyncMutex::new(None))
}

#[tauri::command]
async fn start_backup_scheduler(app: AppHandle, interval_minutes: u64) -> Result<()> {
    if interval_minutes == 0 { return Err(KumaDriveError::InvalidOperation("interval_minutes deve ser maior que 0".into())); }
    stop_backup_scheduler_internal(&app).await;
    let app_handle = app.clone();
    let period = Duration::from_secs(interval_minutes * 60);
    let handle = tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        ticker.tick().await;
        loop { ticker.tick().await; if let Err(err) = app_handle.emit("kumadrive://backup-tick", ()) { eprintln!("[backup_scheduler] falha ao emitir tick: {err}"); } }
    });
    let mut guard = handle_slot().lock().await;
    *guard = Some(handle);
    log_vault_state_internal(&app, format!("BACKUP_SCHEDULER_START interval_minutes={interval_minutes}"));
    Ok(())
}

#[tauri::command]
async fn stop_backup_scheduler(app: AppHandle) -> Result<()> {
    stop_backup_scheduler_internal(&app).await;
    log_vault_state_internal(&app, "BACKUP_SCHEDULER_STOP".to_string());
    Ok(())
}

async fn stop_backup_scheduler_internal(_app: &AppHandle) {
    let mut guard = handle_slot().lock().await;
    if let Some(handle) = guard.take() { handle.abort(); }
}

#[tauri::command]
async fn save_backup_config(app: AppHandle, config: BackupConfig) -> Result<()> {
    let _guard = vault_io_lock().lock().await;
    let config_path = get_backup_config_path(&app)?;
    write_atomic(&config_path, &serde_json::to_string(&config).unwrap())?;
    Ok(())
}

#[tauri::command]
async fn load_backup_config(app: AppHandle) -> Result<Option<BackupConfig>> {
    let config_path = get_backup_config_path(&app)?;
    if !config_path.exists() { return Ok(None); }
    let contents = std::fs::read_to_string(&config_path).map_err(|e| KumaDriveError::ReadFile(e.to_string()))?;
    let config: BackupConfig = serde_json::from_str(&contents).map_err(|e| KumaDriveError::JsonDeserialize(e.to_string()))?;
    Ok(Some(config))
}

fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn walk_recursive(root: &Path, current: &Path, out: &mut Vec<DirEntry>) {
    let entries = match std::fs::read_dir(current) {
        Ok(it) => it,
        Err(err) => { eprintln!("[read_dir_recursive] read_dir({current:?}) failed: {err}"); return; }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = match entry.file_name().into_string() { Ok(s) => s, Err(_) => continue };
        let meta = match std::fs::symlink_metadata(&path) { Ok(m) => m, Err(_) => continue };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let mtime_ms = unix_ms(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        let rel_path = match path.strip_prefix(root) { Ok(p) => p.to_string_lossy().replace('\\', "/"), Err(_) => file_name.clone() };
        out.push(DirEntry { abs_path: path.to_string_lossy().into_owned(), rel_path, is_dir, size, mtime_ms });
        if is_dir { walk_recursive(root, &path, out); }
    }
}

#[tauri::command]
async fn read_dir_recursive(path: String) -> Result<Vec<DirEntry>> {
    let root = Path::new(&path);
    let meta = std::fs::metadata(root).map_err(|e| KumaDriveError::InvalidOperation(format!("stat({path}) failed: {e}")))?;
    if !meta.is_dir() { return Err(KumaDriveError::InvalidOperation(format!("não é um diretório: {path}"))); }
    let path_owned = path.clone();
    let entries = tauri::async_runtime::spawn_blocking(move || -> std::result::Result<Vec<DirEntry>, KumaDriveError> {
        let mut out: Vec<DirEntry> = Vec::new();
        walk_recursive(Path::new(&path_owned), Path::new(&path_owned), &mut out);
        Ok(out)
    }).await    .map_err(|e| KumaDriveError::InvalidOperation(format!("walker join failed: {e}")))?;
    entries
}

#[tauri::command]
async fn read_file_chunk(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response> {
    use std::io::{Read, Seek, SeekFrom};
    let path_owned = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<tauri::ipc::Response, KumaDriveError> {
        let mut file = std::fs::File::open(&path_owned).map_err(|e| KumaDriveError::ReadFile(format!("open({path_owned}) failed: {e}")))?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| KumaDriveError::ReadFile(format!("seek({offset}) failed: {e}")))?;
        let mut buf = vec![0u8; length as usize];
        file.read_exact(&mut buf).map_err(|e| KumaDriveError::ReadFile(format!("read({length} bytes @{offset}) failed: {e}")))?;
        Ok::<tauri::ipc::Response, KumaDriveError>(tauri::ipc::Response::new(buf))
    })
    .await
    .map_err(|e| KumaDriveError::InvalidOperation(format!("read_file_chunk join failed: {e}")))?
}

#[tauri::command]
async fn write_file_binary(path: String, data: Vec<u8>) -> Result<()> {
    use std::io::Write;
    let path_owned = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<(), KumaDriveError> {
        let p = std::path::Path::new(&path_owned);
        if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
        let mut file = std::fs::File::create(p).map_err(|e| KumaDriveError::WriteFile(format!("Failed to create file {path_owned}: {e}")))?;
        file.write_all(&data).map_err(|e| KumaDriveError::WriteFile(format!("Failed to write data to {path_owned}: {e}")))?;
        Ok::<(), KumaDriveError>(())
    })
    .await
    .map_err(|e| KumaDriveError::InvalidOperation(format!("write_file_binary task join error: {e}")))?
}

#[tauri::command]
async fn write_file_chunk(path: String, data: Vec<u8>, append: bool) -> Result<()> {
    use std::io::Write;
    let path_owned = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<(), KumaDriveError> {
        let p = std::path::Path::new(&path_owned);
        if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
        let mut file = std::fs::OpenOptions::new().create(true).write(true).truncate(!append).append(append).open(p).map_err(|e| KumaDriveError::WriteFile(format!("Failed to open file {path_owned}: {e}")))?;
        file.write_all(&data).map_err(|e| KumaDriveError::WriteFile(format!("Failed to write chunk to {path_owned}: {e}")))?;
        Ok::<(), KumaDriveError>(())
    })
    .await
    .map_err(|e| KumaDriveError::InvalidOperation(format!("write_file_chunk task join error: {e}")))?
}

#[tauri::command]
fn open_file_in_system_viewer(app: AppHandle, path: String) -> Result<()> {
    // Abre via plugin opener (chamada direta à API do sistema, sem shell).
    // A versão anterior no Windows fazia `cmd /C start "" <path>`, o que
    // permitia injeção de comandos por nomes de arquivo contendo `&`/`|`/`^`
    // vindos do Telegram.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| KumaDriveError::InvalidOperation(format!("Falha ao abrir o arquivo no visualizador do sistema: {e}")))
}

fn log_vault_state_internal(app: &AppHandle, state: String) {
    if let Ok(log_path) = get_vault_state_log_path(app) {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
            use std::io::Write;
            let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f UTC");
            let _ = writeln!(file, "[{}] {}", timestamp, state);
        }
    }
}

#[tauri::command]
fn log_vault_state(state: String, app: AppHandle) {
    log_vault_state_internal(&app, state);
}

#[tauri::command]
fn get_vault_state(app: AppHandle, lines: Option<usize>) -> Result<String> {
    let limit = lines.unwrap_or(200);
    let log_path = get_vault_state_log_path(&app)?;
    if !log_path.exists() { return Ok(String::new()); }
    let contents = std::fs::read_to_string(&log_path).map_err(|e| KumaDriveError::ReadFile(format!("Failed to read vault_state.log: {e}")))?;
    let collected: Vec<&str> = contents.lines().rev().take(limit).collect();
    let mut out: Vec<&str> = collected;
    out.reverse();
    Ok(out.join("\n"))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Olá, {name}! Você foi saudado do Rust do KumaDrive!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            let salt = b"kumadrive-vault-salt-value";
            let params = argon2::Params::new(1024, 2, 1, Some(32)).unwrap();
            let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
            let mut output_key = [0u8; 32];
            argon2.hash_password_into(password.as_bytes(), salt, &mut output_key).expect("stronghold password hashing failed");
            output_key.to_vec()
        }).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
.plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            save_vault_value,
            load_vault_value,
            delete_vault_value,
            quarantine_vault_value,
            save_session,
            load_session,
            clear_session,
            clear_session_only,
            start_backup_scheduler,
            stop_backup_scheduler,
            save_backup_config,
            load_backup_config,
            read_dir_recursive,
            read_file_chunk,
            write_file_binary,
            write_file_chunk,
            open_file_in_system_viewer,
            log_vault_state,
            get_vault_state,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("erro ao executar aplicação Tauri");
}