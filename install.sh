#!/bin/bash
# ==============================================================================
# BTRFS Manager for Cockpit - Automated One-Line Installer
# Repository : https://github.com/NGxID18/btrfs-manager
# Supported  : Debian/Ubuntu (apt), RHEL/Fedora (dnf), Arch Linux (pacman)
# Usage      : curl -sSL https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash
# ==============================================================================

set -e

# ANSI Color Codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

REPO_URL="https://github.com/NGxID18/btrfs-manager.git"
TARGET_DIR="/usr/share/cockpit/btrfs-manager"

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BOLD}${CYAN}           BTRFS Manager for Cockpit - Automated Installer            ${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

# ------------------------------------------------------------------------------
# 1. Root Privilege Check
# ------------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] This installer must be run as root (or with sudo).${NC}"
    echo -e "Please run:"
    echo -e "  ${YELLOW}curl -sSL https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash${NC}"
    exit 1
fi

# ------------------------------------------------------------------------------
# 2. OS & Package Manager Compatibility Check
# ------------------------------------------------------------------------------
echo -e "${BLUE}[1/5] Checking OS and Package Manager compatibility...${NC}"

OS_NAME="Unknown Linux"
OS_ID="unknown"
OS_ID_LIKE=""

if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-$NAME}"
    OS_ID="${ID:-unknown}"
    OS_ID_LIKE="${ID_LIKE:-}"
fi

PKG_MANAGER=""
ECOSYSTEM=""

if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
    ECOSYSTEM="Debian / Ubuntu Ecosystem (apt)"
elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
    ECOSYSTEM="RHEL / Fedora Ecosystem (dnf)"
elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
    ECOSYSTEM="Arch Linux Ecosystem (pacman)"
else
    echo -e "${RED}[ERROR] Unsupported Operating System or Package Manager!${NC}"
    echo -e "Detected OS: ${YELLOW}${OS_NAME} (ID: ${OS_ID})${NC}"
    echo ""
    echo -e "Currently, BTRFS Manager only guarantees compatibility with:"
    echo -e "  1. ${GREEN}Debian Ecosystem (apt)${NC}    - Debian, Ubuntu, Linux Mint, Pop!_OS, Proxmox, Kali, etc."
    echo -e "  2. ${GREEN}RHEL/Fedora Ecosystem (dnf)${NC} - Fedora, RHEL, Rocky Linux, AlmaLinux, CentOS Stream, Nobara, etc."
    echo -e "  3. ${GREEN}Arch Linux Ecosystem (pacman)${NC} - Arch Linux, Manjaro, EndeavourOS, CachyOS, Garuda, etc."
    exit 1
fi

echo -e "  -> Detected OS        : ${GREEN}${OS_NAME}${NC}"
echo -e "  -> Target Ecosystem   : ${GREEN}${ECOSYSTEM}${NC}"
echo ""

# ------------------------------------------------------------------------------
# 3. Install All Required Dependencies (Fresh OS Ready)
# ------------------------------------------------------------------------------
echo -e "${BLUE}[2/5] Installing required packages and system dependencies...${NC}"

case "$PKG_MANAGER" in
    apt)
        export DEBIAN_FRONTEND=noninteractive
        echo -e "  -> Updating APT package repositories..."
        apt-get update -qq
        echo -e "  -> Installing Cockpit, BTRFS drivers/tools, Snapper, Cron, and core utilities..."
        apt-get install -y \
            cockpit \
            btrfs-progs \
            snapper \
            util-linux \
            e2fsprogs \
            cron \
            anacron \
            git \
            curl \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;

    dnf)
        echo -e "  -> Installing Cockpit, BTRFS drivers/tools, Snapper, Cronie, and core utilities via DNF..."
        dnf install -y \
            cockpit \
            btrfs-progs \
            snapper \
            util-linux \
            e2fsprogs \
            cronie \
            cronie-anacron \
            git \
            curl \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;

    pacman)
        echo -e "  -> Synchronizing Pacman databases and installing dependencies..."
        pacman -Sy --needed --noconfirm \
            cockpit \
            btrfs-progs \
            snapper \
            util-linux \
            e2fsprogs \
            cronie \
            git \
            curl \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;
esac

echo -e "  -> ${GREEN}All dependencies installed successfully.${NC}"
echo ""

# ------------------------------------------------------------------------------
# 4. Enable BTRFS Kernel Module & System Services
# ------------------------------------------------------------------------------
echo -e "${BLUE}[3/5] Enabling BTRFS kernel module and required background services...${NC}"

# Load BTRFS kernel module
if modprobe btrfs 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Loaded${NC}"
elif grep -q "btrfs" /proc/filesystems 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Built-in (Active)${NC}"
else
    echo -e "  -> BTRFS kernel driver       : ${YELLOW}Warning - Could not verify btrfs module in current kernel.${NC}"
fi

# Ensure standard cron directories exist
mkdir -p /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly

# Enable and start Cockpit Web Console socket
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl enable --now cockpit.socket >/dev/null 2>&1 || true
    echo -e "  -> Cockpit Web Console       : ${GREEN}Enabled (cockpit.socket)${NC}"

    # Enable and start Cron service according to distro
    if systemctl list-unit-files | grep -q "^cron\.service"; then
        systemctl enable --now cron.service >/dev/null 2>&1 || true
        echo -e "  -> Cron Scheduler Service    : ${GREEN}Active (cron.service)${NC}"
    elif systemctl list-unit-files | grep -q "^crond\.service"; then
        systemctl enable --now crond.service >/dev/null 2>&1 || true
        echo -e "  -> Cron Scheduler Service    : ${GREEN}Active (crond.service)${NC}"
    elif systemctl list-unit-files | grep -q "^cronie\.service"; then
        systemctl enable --now cronie.service >/dev/null 2>&1 || true
        echo -e "  -> Cron Scheduler Service    : ${GREEN}Active (cronie.service)${NC}"
    fi

    # Enable Snapper cleanup timer
    systemctl enable --now snapper-cleanup.timer >/dev/null 2>&1 || true
    echo -e "  -> Snapper Cleanup Timer     : ${GREEN}Enabled (snapper-cleanup.timer)${NC}"
else
    echo -e "  -> ${YELLOW}Systemd is not running as PID 1 (container environment). Service activation skipped.${NC}"
fi
echo ""

# ------------------------------------------------------------------------------
# 5. Clone or Update BTRFS Manager Extension
# ------------------------------------------------------------------------------
echo -e "${BLUE}[4/5] Installing BTRFS Manager to ${TARGET_DIR}...${NC}"

mkdir -p /usr/share/cockpit

if [ -d "$TARGET_DIR/.git" ]; then
    echo -e "  -> Existing Git installation detected. Fetching latest updates..."
    git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || \
    git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true
    git -C "$TARGET_DIR" fetch origin main
    git -C "$TARGET_DIR" reset --hard origin/main
else
    if [ -d "$TARGET_DIR" ]; then
        echo -e "  -> Removing previous non-git directory at ${TARGET_DIR}..."
        rm -rf "$TARGET_DIR"
    fi
    echo -e "  -> Cloning repository from ${REPO_URL}..."
    git clone "$REPO_URL" "$TARGET_DIR"
    git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || \
    git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 6. Set Permissions & Finalize
# ------------------------------------------------------------------------------
echo -e "${BLUE}[5/5] Setting file permissions and finalizing installation...${NC}"

chown -R root:root "$TARGET_DIR" 2>/dev/null || true
chmod -R 755 "$TARGET_DIR"

# Restart cockpit service gently if running so it picks up the new manifest immediately
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl try-restart cockpit.service >/dev/null 2>&1 || true
fi

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="localhost"

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${BOLD}${GREEN}  ✔ BTRFS Manager for Cockpit has been installed successfully!        ${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "  Installation Path : ${CYAN}${TARGET_DIR}${NC}"
echo -e "  Cockpit Web URL   : ${BOLD}${YELLOW}https://${SERVER_IP}:9090${NC}"
echo ""
echo -e "  Next Steps:"
echo -e "  1. Open your browser and navigate to ${YELLOW}https://${SERVER_IP}:9090${NC}"
echo -e "  2. Log in with your Linux system credentials."
echo -e "  3. Click ${CYAN}BTRFS${NC} in the Cockpit navigation sidebar."
echo -e "${GREEN}======================================================================${NC}"
