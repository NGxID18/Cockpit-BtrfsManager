#!/bin/bash
# ==============================================================================
# BTRFS Manager for Cockpit - Automated Installer & Manager
# Repository : https://github.com/NGxID18/btrfs-manager
# Supported  : Debian/Ubuntu (apt), RHEL/Fedora (dnf), Arch Linux (pacman), openSUSE (zypper)
# Usage      : curl -sSL https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash
#              wget -qO- https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash
# Uninstall  : sudo bash install.sh --uninstall
# ==============================================================================

set -euo pipefail

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

# ------------------------------------------------------------------------------
# 1. Root Privilege Check
# ------------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] This script must be run as root (or with sudo).${NC}"
    echo -e "Please run:"
    echo -e "  ${YELLOW}curl -sSL https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash${NC}"
    exit 1
fi

# ------------------------------------------------------------------------------
# Handle --uninstall flag
# ------------------------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "-u" ]; then
    echo -e "${BLUE}======================================================================${NC}"
    echo -e "${BOLD}${RED}             BTRFS Manager for Cockpit - Uninstaller                 ${NC}"
    echo -e "${BLUE}======================================================================${NC}"
    echo ""
    echo -e "${YELLOW}Removing BTRFS Manager extension from ${TARGET_DIR}...${NC}"
    rm -rf "$TARGET_DIR"

    # Remove any cron scripts created by the extension
    echo -e "${YELLOW}Cleaning up automated backup cron jobs...${NC}"
    for cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
        if [ -d "$cdir" ]; then
            rm -f "$cdir"/btrfs_snap_* 2>/dev/null || true
        fi
    done

    # Restart cockpit if running
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        systemctl try-restart cockpit.service >/dev/null 2>&1 || true
    fi

    echo ""
    echo -e "${GREEN}✔ BTRFS Manager has been completely removed from this system.${NC}"
    echo -e "${BLUE}======================================================================${NC}"
    exit 0
fi

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BOLD}${CYAN}           BTRFS Manager for Cockpit - Automated Installer            ${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

# ------------------------------------------------------------------------------
# 2. OS & Package Manager Compatibility Check
# ------------------------------------------------------------------------------
echo -e "${BLUE}[1/5] Checking OS and Package Manager compatibility...${NC}"

OS_NAME="Unknown Linux"
OS_ID="unknown"

if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-$NAME}"
    OS_ID="${ID:-unknown}"
fi

PKG_MANAGER=""
ECOSYSTEM=""

if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
    ECOSYSTEM="Debian / Ubuntu Ecosystem (apt)"
elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
    ECOSYSTEM="RHEL / Fedora Ecosystem (dnf)"
elif command -v zypper >/dev/null 2>&1; then
    PKG_MANAGER="zypper"
    ECOSYSTEM="openSUSE Ecosystem (zypper)"
elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
    ECOSYSTEM="Arch Linux Ecosystem (pacman)"
else
    echo -e "${RED}[ERROR] Unsupported Operating System or Package Manager!${NC}"
    echo -e "Detected OS: ${YELLOW}${OS_NAME} (ID: ${OS_ID})${NC}"
    echo ""
    echo -e "Supported package managers for automatic setup:"
    echo -e "  1. ${GREEN}Debian / Ubuntu (apt)${NC}    - Debian 12/13, Ubuntu 24.04-26.10, Mint, Pop!_OS"
    echo -e "  2. ${GREEN}RHEL / Fedora (dnf)${NC}      - Fedora 42-44, RHEL 10, Rocky Linux 10, AlmaLinux 10"
    echo -e "  3. ${GREEN}openSUSE (zypper)${NC}        - openSUSE Leap 16, openSUSE Tumbleweed"
    echo -e "  4. ${GREEN}Arch Linux (pacman)${NC}      - Arch Linux, Manjaro, CachyOS, EndeavourOS"
    exit 1
fi

echo -e "  -> Detected OS        : ${GREEN}${OS_NAME}${NC}"
echo -e "  -> Target Ecosystem   : ${GREEN}${ECOSYSTEM}${NC}"
echo ""

# ------------------------------------------------------------------------------
# 3. Install Required Dependencies
# ------------------------------------------------------------------------------
echo -e "${BLUE}[2/5] Installing required packages and system dependencies...${NC}"

case "$PKG_MANAGER" in
    apt)
        export DEBIAN_FRONTEND=noninteractive
        echo -e "  -> Updating APT package lists..."
        apt-get update -qq
        echo -e "  -> Installing Cockpit, Btrfs utilities, Snapper, Cron, and core tools..."
        apt-get install -y --no-install-recommends \
            cockpit \
            btrfs-progs \
            snapper \
            util-linux \
            e2fsprogs \
            cron \
            anacron \
            git \
            curl \
            wget \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;

    dnf)
        echo -e "  -> Installing Cockpit, Btrfs utilities, Snapper, Cronie, and core tools via DNF..."
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
            wget \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;

    zypper)
        echo -e "  -> Installing Cockpit, Btrfs utilities, Snapper, Cronie, and core tools via Zypper..."
        # openSUSE package names: btrfsprogs (alias for btrfs-progs)
        zypper --non-interactive install --no-recommends -y \
            cockpit \
            btrfsprogs \
            snapper \
            util-linux \
            e2fsprogs \
            cronie \
            git \
            curl \
            wget \
            ca-certificates \
            gawk \
            grep \
            sed \
            coreutils \
            findutils
        ;;

    pacman)
        echo -e "  -> Installing dependencies via Pacman..."
        pacman -S --needed --noconfirm \
            cockpit \
            btrfs-progs \
            snapper \
            util-linux \
            e2fsprogs \
            cronie \
            git \
            curl \
            wget \
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
# 4. Enable Kernel Module & Background Services
# ------------------------------------------------------------------------------
echo -e "${BLUE}[3/5] Verifying BTRFS kernel support and system services...${NC}"

# Load BTRFS kernel module if not already loaded or built-in
if modprobe btrfs 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Active (Module loaded)${NC}"
elif grep -q "btrfs" /proc/filesystems 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Active (Built-in kernel)${NC}"
else
    echo -e "  -> BTRFS kernel driver       : ${YELLOW}Warning: Could not verify btrfs in current kernel.${NC}"
fi

# Ensure standard cron directories exist
mkdir -p /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly

# Enable Cockpit socket and cron service if systemd is active
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl enable --now cockpit.socket >/dev/null 2>&1 || true
    echo -e "  -> Cockpit Web Console       : ${GREEN}Enabled (cockpit.socket)${NC}"

    # Enable and start Cron service according to distro naming
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

    # Enable Snapper cleanup timer if present
    if systemctl list-unit-files | grep -q "^snapper-cleanup\.timer"; then
        systemctl enable --now snapper-cleanup.timer >/dev/null 2>&1 || true
        echo -e "  -> Snapper Cleanup Timer     : ${GREEN}Enabled (snapper-cleanup.timer)${NC}"
    fi
else
    echo -e "  -> ${YELLOW}Container or non-systemd environment detected. Service activation skipped.${NC}"
fi
echo ""

# ------------------------------------------------------------------------------
# 5. Download and Deploy Extension
# ------------------------------------------------------------------------------
echo -e "${BLUE}[4/5] Deploying BTRFS Manager to ${TARGET_DIR}...${NC}"

mkdir -p /usr/share/cockpit

if [ -d "$TARGET_DIR/.git" ]; then
    echo -e "  -> Existing Git repository detected. Updating to latest release..."
    git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || true
    git -C "$TARGET_DIR" fetch origin main
    git -C "$TARGET_DIR" reset --hard origin/main
else
    if [ -d "$TARGET_DIR" ]; then
        echo -e "  -> Replacing previous installation at ${TARGET_DIR}..."
        rm -rf "$TARGET_DIR"
    fi
    echo -e "  -> Downloading latest code from repository..."
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
    git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# 6. File Permissions & Cockpit Reload
# ------------------------------------------------------------------------------
echo -e "${BLUE}[5/5] Finalizing permissions and registering with Cockpit...${NC}"

# Detect real calling user (who invoked sudo/curl)
REAL_USER="${SUDO_USER:-}"
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
    REAL_USER=$(logname 2>/dev/null || who am i 2>/dev/null | awk '{print $1}')
fi
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
    REAL_USER=$(awk -F: '$3 >= 1000 && $3 < 60000 {print $1; exit}' /etc/passwd 2>/dev/null || echo "")
fi

# Set ownership to real user and grant full developer read-write access
if [ -n "$REAL_USER" ] && id "$REAL_USER" >/dev/null 2>&1; then
    REAL_GROUP=$(id -gn "$REAL_USER" 2>/dev/null || echo "$REAL_USER")
    chown -R "$REAL_USER:$REAL_GROUP" "$TARGET_DIR" 2>/dev/null || true
    su - "$REAL_USER" -c "git config --global --add safe.directory '$TARGET_DIR'" 2>/dev/null || true
fi

# Grant full read-write permissions so developers can edit and save files without requiring sudo
chmod -R ugo+rwX "$TARGET_DIR"
chmod 755 "$TARGET_DIR/install.sh" 2>/dev/null || true
git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || true

# Gently restart cockpit service if running so it detects the extension manifest immediately
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl try-restart cockpit.service >/dev/null 2>&1 || true
fi

# Detect primary server IP address for display
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="localhost"

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${BOLD}${GREEN}  ✔ BTRFS Manager for Cockpit has been successfully installed!        ${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "  Installation Path : ${CYAN}${TARGET_DIR}${NC}"
echo -e "  Cockpit Web URL   : ${BOLD}${YELLOW}https://${SERVER_IP}:9090${NC}"
echo ""
echo -e "  Getting Started:"
echo -e "  1. Open your browser and visit ${YELLOW}https://${SERVER_IP}:9090${NC}"
echo -e "  2. Log in with your Linux credentials."
echo -e "  3. Click ${CYAN}BTRFS Manager${NC} in the left sidebar."
echo ""
echo -e "  To uninstall in the future:"
echo -e "    ${YELLOW}sudo /usr/share/cockpit/btrfs-manager/install.sh --uninstall${NC}"
echo -e "${GREEN}======================================================================${NC}"

