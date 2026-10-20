use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
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

/// Handle de arquivo reutilizável para leitura sequencial de chunks.
///
/// Por que existe: o uploader lê um arquivo em chunks de 1MB via
/// `read_file_chunk`. Sem pool, cada chunk pagava `File::open` + `seek` +
/// `close` (3 chamadas de sistema) além de um round-trip de IPC. Num
/// arquivo de 1GB isso eram ~1024 aberturas/seek/close. Guardar o handle
/// entre chunks deixa só o `seek` + `read` por chunk.
struct CachedHandle {
    file: std::fs::File,
    last_used: Instant,
}

/// Pool global de handles, chaveado pelo caminho do arquivo.
static FILE_HANDLES: LazyLock<Mutex<HashMap<String, CachedHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Teto de handles abertos simultaneamente. O uploader de backup roda um
/// pool de ~3 arquivos concorrentes; 16 dá folga para o upload normal e
/// para o usuário navegando, sem segurar descritores demais.
const MAX_CACHED_HANDLES: usize = 16;

/// Um handle ocioso por mais que isto é fechado na próxima faxina.
/// Evita segurar descritores de arquivos que não voltam a ser lidos.
const CACHED_HANDLE_TTL: Duration = Duration::from_secs(30);

/// Teto de bytes por chunk. O cliente pede chunks de 1MB; aceitamos até 8MB
/// de folga, mas recusamos `length` arbitrário — `vec![0u8; length]` com um
/// `length` vindo do IPC era um OOM trivial (DoS pelo webview).
const MAX_CHUNK_BYTES: u64 = 8 * 1024 * 1024;

/// Lê `length` bytes em `offset` reutilizando um handle em cache.
///
/// Lê em LOOP até preencher `length` ou atingir EOF real. Um `read()` cru
/// pode devolver um short read mesmo no meio do arquivo (filesystems de
/// rede, interrupções), e tratar isso como chunk completo enviaria bytes
/// faltando para o Telegram — corrupção silenciosa. Só o chunk FINAL pode
/// ser legitimamente menor que `length`.
fn read_chunk_with_pool(path: &str, offset: u64, length: u64) -> std::result::Result<Vec<u8>, KumaDriveError> {
    if length == 0 || length > MAX_CHUNK_BYTES {
        return Err(KumaDriveError::InvalidOperation(format!(
            "read_file_chunk: length inválido ({length}); esperado 1..={MAX_CHUNK_BYTES}"
        )));
    }

    let mut pool = FILE_HANDLES
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    // Faxina preguiçosa: remove handles ociosos além do TTL.
    let now = Instant::now();
    pool.retain(|_, h| now.duration_since(h.last_used) < CACHED_HANDLE_TTL);

    if !pool.contains_key(path) {
        // Se o pool está cheio, evicta o handle mais antigo (LRU).
        if pool.len() >= MAX_CACHED_HANDLES {
            if let Some(oldest) = pool
                .iter()
                .min_by_key(|(_, h)| h.last_used)
                .map(|(k, _)| k.clone())
            {
                pool.remove(&oldest);
            }
        }
        let file = std::fs::File::open(path)
            .map_err(|e| KumaDriveError::ReadFile(format!("open({path}) failed: {e}")))?;
        pool.insert(
            path.to_string(),
            CachedHandle {
                file,
                last_used: now,
            },
        );
    }

    let entry = pool
        .get_mut(path)
        .ok_or_else(|| KumaDriveError::ReadFile(format!("handle desapareceu do pool: {path}")))?;
    entry
        .file
        .seek(SeekFrom::Start(offset))
        .map_err(|e| KumaDriveError::ReadFile(format!("seek({offset}) failed: {e}")))?;
    let mut buf = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = entry
            .file
            .read(&mut buf[filled..])
            .map_err(|e| KumaDriveError::ReadFile(format!("read({length} @{offset}) failed: {e}")))?;
        if n == 0 {
            break; // EOF real — só o chunk final pode ser curto
        }
        filled += n;
    }
    buf.truncate(filled);
    entry.last_used = now;
    Ok(buf)
}

/// Fecha e remove do pool os handles dos caminhos informados. O uploader
/// chama isto quando termina de enviar um arquivo, para não segurar
/// descritores nem manter o handle obsoleto se o arquivo for trocado.
fn release_file_handle(path: &str) {
    // Recupera o guard mesmo se o mutex estiver envenenado (um panic em
    // outra thread segurando o lock). Sem isto, um único panic deixaria o
    // pool morto para sempre em silêncio.
    let mut pool = FILE_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
    pool.remove(path);
}

#[tauri::command]
fn release_file_handles(paths: Vec<String>) -> Result<()> {
    // Lista explícita obrigatória: NÃO aceitamos "limpar tudo" pelo IPC.
    // Um `None`/lista vazia significaria destruir o pool global a pedido
    // do frontend — um vetor de DoS trivial (força reabrir todo arquivo em
    // todo chunk) e acopla subsistemas sem necessidade. O teardown do pool
    // inteiro acontece pelo lado Rust, não pelo webview.
    //
    // Teto de itens: um Vec gigante faria churn do mapa sob o lock — DoS barato.
    const MAX_RELEASE_BATCH: usize = 256;
    if paths.len() > MAX_RELEASE_BATCH {
        return Err(KumaDriveError::InvalidOperation(format!(
            "release_file_handles: {} caminhos excede o teto de {}",
            paths.len(),
            MAX_RELEASE_BATCH
        )));
    }
    for p in paths {
        release_file_handle(&p);
    }
    Ok(())
}

#[tauri::command]
async fn read_file_chunk(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response> {
    let path_owned = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::result::Result<tauri::ipc::Response, KumaDriveError> {
        let buf = read_chunk_with_pool(&path_owned, offset, length)?;
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
            release_file_handles,
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