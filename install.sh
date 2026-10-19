#!/bin/bash
# ==============================================================================
# KumaDrive - Universal 1-Line Installer for macOS & Linux
# https://github.com/AkumaHalls/KumaDrive
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}                      KumaDrive Installer                       ${NC}"
echo -e "${CYAN}        Armazenamento em nuvem ilimitado via Telegram           ${NC}"
echo -e "${CYAN}================================================================${NC}"
echo ""

OS="$(uname -s)"
ARCH="$(uname -m)"

LATEST_RELEASE="https://github.com/AkumaHalls/KumaDrive/releases/latest/download"
RELEASES_PAGE="https://github.com/AkumaHalls/KumaDrive/releases"

if [ "$OS" = "Darwin" ]; then
    echo -e "${BLUE}-> macOS detectado ($ARCH)${NC}"
    echo -e "   Baixando o DMG Universal mais recente do KumaDrive..."

    TMP_DIR="$(mktemp -d)"
    DMG_PATH="$TMP_DIR/kumadrive.dmg"
    MOUNT_DIR="$TMP_DIR/mount"

    if ! curl -fsSL "$LATEST_RELEASE/KumaDrive_universal.dmg" -o "$DMG_PATH" 2>/dev/null; then
        echo -e "${RED}   Nao foi possivel baixar o DMG. Ainda nao ha build para macOS publicado.${NC}"
        echo -e "   Baixe manualmente em: $RELEASES_PAGE"
        rm -rf "$TMP_DIR"
        exit 1
    fi

    echo -e "   Montando a imagem de disco..."
    mkdir -p "$MOUNT_DIR"
    hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -quiet

    echo -e "   Instalando KumaDrive em /Applications..."
    if [ -d "/Applications/KumaDrive.app" ]; then
        rm -rf "/Applications/KumaDrive.app"
    fi
    cp -R "$MOUNT_DIR/KumaDrive.app" /Applications/KumaDrive.app

    echo -e "   Configurando a autorizacao do Gatekeeper do macOS..."
    xattr -cr /Applications/KumaDrive.app 2>/dev/null || true
    codesign --force --deep --sign - /Applications/KumaDrive.app 2>/dev/null || true

    echo -e "   Limpando..."
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
    rm -rf "$TMP_DIR"

    echo ""
    echo -e "${GREEN}[ok] KumaDrive instalado com sucesso em /Applications/KumaDrive.app${NC}"
    echo -e "${GREEN}[ok] Quarentena do Gatekeeper removida - pronto para abrir!${NC}"
    echo ""

    read -p "Abrir o KumaDrive agora? [S/n]: " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Ss]$ ]] || [[ -z $REPLY ]]; then
        open /Applications/KumaDrive.app
    fi

elif [ "$OS" = "Linux" ]; then
    echo -e "${BLUE}-> Linux detectado ($ARCH)${NC}"
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
    APPIMAGE_PATH="$INSTALL_DIR/kumadrive.AppImage"

    echo -e "   Baixando o AppImage mais recente do KumaDrive..."
    if ! curl -fsSL "$LATEST_RELEASE/KumaDrive_amd64.AppImage" -o "$APPIMAGE_PATH" 2>/dev/null; then
        echo -e "${RED}   Nao foi possivel baixar o AppImage. Ainda nao ha build para Linux publicado.${NC}"
        echo -e "   Baixe manualmente em: $RELEASES_PAGE"
        exit 1
    fi

    chmod +x "$APPIMAGE_PATH"

    echo ""
    echo -e "${GREEN}[ok] KumaDrive AppImage instalado em $APPIMAGE_PATH${NC}"
    echo -e "     Execute com: $APPIMAGE_PATH"
    echo ""

else
    echo -e "${RED}Sistema operacional nao suportado: $OS${NC}"
    echo "Baixe o instalador para Windows (.exe) em $RELEASES_PAGE"
    exit 1
fi
