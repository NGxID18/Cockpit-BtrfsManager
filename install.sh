#!/bin/bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

REPO_URL="https://github.com/NGxID18/Cockpit-BtrfsManager.git"
TARGET_DIR="/usr/share/cockpit/btrfsmanager"

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR] This script must be run as root (or with sudo).${NC}"
    echo -e "Please run:"
    echo -e "  ${YELLOW}curl -sSL https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash${NC}"
    exit 1
fi

detect_os_and_pkg_manager() {
    OS_NAME="Unknown Linux"
    OS_ID="unknown"

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="${PRETTY_NAME:-${NAME:-Unknown Linux}}"
        OS_ID="${ID:-unknown}"
    fi

    PKG_MANAGER=""
    ECOSYSTEM=""

    if command -v apt-get >/dev/null 2>&1; then
        PKG_MANAGER="apt"
        ECOSYSTEM="Debian / Ubuntu Ecosystem (apt)"
    elif command -v dnf >/dev/null 2>&1; then
        PKG_MANAGER="dnf"
        ECOSYSTEM="Fedora / AlmaLinux Ecosystem (dnf)"
    elif command -v zypper >/dev/null 2>&1; then
        PKG_MANAGER="zypper"
        ECOSYSTEM="openSUSE Ecosystem (zypper)"
    elif command -v pacman >/dev/null 2>&1; then
        PKG_MANAGER="pacman"
        ECOSYSTEM="Arch Linux Ecosystem (pacman)"
    fi
}

is_cockpit_installed() {
    if command -v cockpit-bridge >/dev/null 2>&1; then
        return 0
    fi
    if [ -x /usr/lib/cockpit/cockpit-ws ] || [ -x /usr/libexec/cockpit-ws ]; then
        return 0
    fi
    if [ -f /usr/lib/systemd/system/cockpit.socket ] || [ -f /lib/systemd/system/cockpit.socket ] || [ -f /etc/systemd/system/cockpit.socket ]; then
        return 0
    fi
    return 1
}

is_port_9090_listening() {
    if command -v ss >/dev/null 2>&1; then
        if ss -Htln 2>/dev/null | awk '$4 ~ /:9090$/ { found=1 } END { exit !found }'; then
            return 0
        fi
        return 1
    fi

    local tcp_files=()
    [ -r /proc/net/tcp ] && tcp_files+=(/proc/net/tcp)
    [ -r /proc/net/tcp6 ] && tcp_files+=(/proc/net/tcp6)
    if [ "${#tcp_files[@]}" -gt 0 ] && awk '$4 == "0A" && $2 ~ /:2382$/ { found=1 } END { exit !found }' "${tcp_files[@]}" 2>/dev/null; then
        return 0
    fi
    return 1
}

get_port_9090_listeners() {
    if command -v ss >/dev/null 2>&1; then
        ss -Htln 2>/dev/null | awk '$4 ~ /:9090$/ { print $4 }' | tr '\n' ',' | sed 's/,$//; s/,/, /g' || true
    fi
}

is_root_btrfs() {
    if [ -r /proc/mounts ] && awk '$2 == "/" && $3 == "btrfs" { found=1 } END { exit !found }' /proc/mounts 2>/dev/null; then
        return 0
    fi
    return 1
}

get_btrfs_mounts() {
    if [ -r /proc/mounts ]; then
        awk '$3 == "btrfs" { print $2 }' /proc/mounts 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true
    fi
}

is_pkg_installed() {
    local pkg="$1"
    case "$PKG_MANAGER" in
        apt)
            dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"
            ;;
        dnf|zypper)
            rpm -q "$pkg" >/dev/null 2>&1
            ;;
        pacman)
            pacman -Qq "$pkg" >/dev/null 2>&1
            ;;
        *)
            return 1
            ;;
    esac
}

remove_packages() {
    local installed=()
    local pkg
    for pkg in "$@"; do
        if is_pkg_installed "$pkg"; then
            installed+=("$pkg")
        fi
    done

    if [ "${#installed[@]}" -eq 0 ]; then
        echo -e "  -> ${YELLOW}No matching installed packages found to remove.${NC}"
        return 0
    fi

    echo -e "  -> Removing packages: ${CYAN}${installed[*]}${NC}"
    case "$PKG_MANAGER" in
        apt)
            DEBIAN_FRONTEND=noninteractive apt-get remove -y "${installed[@]}" || echo -e "  -> ${YELLOW}Warning: Some packages could not be removed cleanly due to dependencies.${NC}"
            ;;
        dnf)
            dnf remove -y "${installed[@]}" || echo -e "  -> ${YELLOW}Warning: Some packages could not be removed cleanly due to dependencies.${NC}"
            ;;
        zypper)
            zypper --non-interactive remove -y "${installed[@]}" || echo -e "  -> ${YELLOW}Warning: Some packages could not be removed cleanly due to dependencies.${NC}"
            ;;
        pacman)
            pacman -Rs --noconfirm "${installed[@]}" || echo -e "  -> ${YELLOW}Warning: Some packages could not be removed cleanly due to dependencies.${NC}"
            ;;
    esac
}

remove_extension_files() {
    local cdir
    echo -e "${YELLOW}Removing BTRFS Manager extension from ${TARGET_DIR}...${NC}"
    rm -rf "$TARGET_DIR"
    rm -rf "/usr/share/cockpit/btrfs-manager"

    echo -e "${YELLOW}Cleaning up automated backup cron jobs...${NC}"
    for cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
        if [ -d "$cdir" ]; then
            rm -f "$cdir"/btrfs_snap_* 2>/dev/null || true
        fi
    done
}

can_prompt_tty() {
    if [ -t 0 ]; then
        return 0
    fi
    if ( : </dev/tty ) 2>/dev/null; then
        return 0
    fi
    return 1
}

read_user_input() {
    USER_INPUT=""
    if [ -t 0 ]; then
        IFS= read -r USER_INPUT || return 1
    elif ( : </dev/tty ) 2>/dev/null; then
        IFS= read -r USER_INPUT </dev/tty || return 1
    else
        return 1
    fi
}

if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "-u" ]; then
    MODE_FLAG="${2:-}"
    FORCE_FLAG="${3:-}"
    UNINSTALL_MODE=""
    IS_INTERACTIVE=false

    if can_prompt_tty; then
        IS_INTERACTIVE=true
    fi

    case "$MODE_FLAG" in
        "")
            ;;
        --extension-only)
            UNINSTALL_MODE="1"
            ;;
        --with-btrfs)
            UNINSTALL_MODE="2"
            ;;
        --all)
            UNINSTALL_MODE="3"
            ;;
        *)
            echo -e "${RED}[ERROR] Unknown uninstall option: ${MODE_FLAG}${NC}"
            echo -e "Usage: sudo $0 --uninstall [--extension-only | --with-btrfs | --all] [--force]"
            exit 1
            ;;
    esac

    if [ -n "$FORCE_FLAG" ] && [ "$FORCE_FLAG" != "--force" ]; then
        echo -e "${RED}[ERROR] Unknown uninstall flag: ${FORCE_FLAG}${NC}"
        echo -e "Usage: sudo $0 --uninstall [--extension-only | --with-btrfs | --all] [--force]"
        exit 1
    fi

    echo -e "${BLUE}======================================================================${NC}"
    echo -e "${BOLD}${RED}             BTRFS Manager for Cockpit - Uninstaller                 ${NC}"
    echo -e "${BLUE}======================================================================${NC}"
    echo ""

    if [ -z "$UNINSTALL_MODE" ]; then
        if [ "$IS_INTERACTIVE" = true ]; then
            echo -e "Select uninstallation scope:"
            echo -e "  ${GREEN}1.${NC} Extension only ${CYAN}(Recommended)${NC}"
            echo -e "     Removes BTRFS Manager UI and automated snapshot cron jobs."
            echo -e "     Keeps Cockpit, Btrfs tools, and Snapper intact."
            echo -e "  ${YELLOW}2.${NC} Extension + Btrfs & Snapshot tools"
            echo -e "     Removes extension, cron jobs, btrfs-progs/btrfsprogs, and snapper."
            echo -e "     Keeps Cockpit, cron daemon, and git intact."
            echo -e "  ${RED}3.${NC} Complete removal (Cockpit + Extension + Btrfs & Snapshot tools)"
            echo -e "     Stops/disables Cockpit and removes Cockpit, extension, cron jobs,"
            echo -e "     btrfs-progs/btrfsprogs, and snapper. Keeps cron daemon and git."
            echo -e "  0. Cancel"
            echo ""
            printf "Enter your choice [1-3, default 1]: "
            if ! read_user_input; then
                echo ""
                echo -e "${YELLOW}Uninstallation cancelled.${NC}"
                exit 0
            fi
            UNINSTALL_MODE="${USER_INPUT:-1}"
        else
            UNINSTALL_MODE="1"
            echo -e "${YELLOW}Non-interactive environment detected without mode flag; defaulting to Option 1 (Extension only).${NC}"
            echo -e "Explicit flags: --extension-only | --with-btrfs | --all"
            echo ""
        fi
    fi

    case "$UNINSTALL_MODE" in
        0)
            echo -e "${YELLOW}Uninstallation cancelled.${NC}"
            exit 0
            ;;
        1|2|3)
            ;;
        *)
            echo -e "${RED}[ERROR] Invalid selection '${UNINSTALL_MODE}'. Uninstallation cancelled.${NC}"
            exit 1
            ;;
    esac

    if [ "$UNINSTALL_MODE" = "2" ] || [ "$UNINSTALL_MODE" = "3" ]; then
        detect_os_and_pkg_manager
        if [ -z "$PKG_MANAGER" ]; then
            echo -e "${RED}[ERROR] Unsupported package manager; cannot remove system packages automatically.${NC}"
            echo -e "Detected OS: ${YELLOW}${OS_NAME} (ID: ${OS_ID})${NC}"
            exit 1
        fi

        BTRFS_MOUNTS=$(get_btrfs_mounts)
        if is_root_btrfs; then
            echo -e "${BOLD}${RED}[WARNING] Your root filesystem (/) is currently mounted as Btrfs!${NC}"
            echo -e "${RED}Removing btrfs-progs/btrfsprogs on a Btrfs root system can break initramfs regeneration or boot recovery.${NC}"
            echo -e "Active Btrfs mounts: ${YELLOW}${BTRFS_MOUNTS}${NC}"
            echo ""
            if [ "$IS_INTERACTIVE" = true ] && [ "$FORCE_FLAG" != "--force" ]; then
                printf "Type YES (uppercase) to confirm removing Btrfs packages anyway: "
                if ! read_user_input || [ "$USER_INPUT" != "YES" ]; then
                    echo -e "${YELLOW}Uninstallation cancelled to protect your Btrfs root filesystem.${NC}"
                    exit 0
                fi
            elif [ "$FORCE_FLAG" != "--force" ]; then
                echo -e "${RED}[ABORTED] Refusing to remove Btrfs tools on a Btrfs root filesystem non-interactively without --force.${NC}"
                exit 1
            fi
        elif [ -n "$BTRFS_MOUNTS" ]; then
            echo -e "${YELLOW}[WARNING] Active Btrfs mounts detected on this system: ${BTRFS_MOUNTS}${NC}"
            echo -e "${YELLOW}Removing btrfs-progs/btrfsprogs will disable user-space management tools for those filesystems.${NC}"
            echo ""
            if [ "$IS_INTERACTIVE" = true ] && [ "$FORCE_FLAG" != "--force" ]; then
                printf "Proceed with package removal? [y/N]: "
                if ! read_user_input || [[ ! "$USER_INPUT" =~ ^[Yy]$ ]]; then
                    echo -e "${YELLOW}Uninstallation cancelled.${NC}"
                    exit 0
                fi
            fi
        elif [ "$IS_INTERACTIVE" = true ] && [ "$FORCE_FLAG" != "--force" ]; then
            echo -e "${YELLOW}The selected packages will be removed via ${PKG_MANAGER}.${NC}"
            printf "Proceed with package removal? [y/N]: "
            if ! read_user_input || [[ ! "$USER_INPUT" =~ ^[Yy]$ ]]; then
                echo -e "${YELLOW}Uninstallation cancelled.${NC}"
                exit 0
            fi
        fi
    fi

    remove_extension_files

    case "$UNINSTALL_MODE" in
        1)
            echo ""
            echo -e "${GREEN}✔ BTRFS Manager extension and backup cron jobs have been removed.${NC}"
            echo -e "  -> Cockpit, Btrfs utilities, and Snapper were preserved."
            echo -e "  -> Refresh Cockpit in your browser if it is currently open (no service restart required)."
            ;;
        2)
            echo -e "${YELLOW}Removing Btrfs and Snapper utilities...${NC}"
            if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
                systemctl disable --now snapper-cleanup.timer >/dev/null 2>&1 || true
            fi
            if [ "$PKG_MANAGER" = "zypper" ]; then
                remove_packages btrfsprogs snapper
            else
                remove_packages btrfs-progs snapper
            fi
            echo ""
            echo -e "${GREEN}✔ BTRFS Manager extension and Btrfs/Snapper utilities have been removed.${NC}"
            echo -e "  -> Cockpit, cron daemon, and git were preserved."
            echo -e "  -> Refresh Cockpit in your browser if it is currently open (no service restart required)."
            ;;
        3)
            echo -e "${YELLOW}Stopping Cockpit services and removing Cockpit, Btrfs, and Snapper packages...${NC}"
            if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
                systemctl disable --now cockpit.socket cockpit.service snapper-cleanup.timer >/dev/null 2>&1 || true
            fi
            case "$PKG_MANAGER" in
                apt|dnf)
                    remove_packages cockpit cockpit-ws cockpit-bridge cockpit-system btrfs-progs snapper
                    ;;
                zypper)
                    remove_packages cockpit cockpit-ws cockpit-bridge cockpit-system btrfsprogs snapper
                    ;;
                pacman)
                    remove_packages cockpit btrfs-progs snapper
                    ;;
            esac
            echo ""
            echo -e "${GREEN}✔ Cockpit, BTRFS Manager extension, and Btrfs/Snapper utilities have been removed.${NC}"
            echo -e "  -> Cron daemon and git were preserved."
            ;;
    esac

    echo -e "${BLUE}======================================================================${NC}"
    exit 0
fi

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BOLD}${CYAN}           BTRFS Manager for Cockpit - Automated Installer            ${NC}"
echo -e "${BLUE}======================================================================${NC}"
echo ""

echo -e "${BLUE}[1/5] Checking OS, Package Manager, and existing Cockpit setup...${NC}"

detect_os_and_pkg_manager

if [ -z "$PKG_MANAGER" ]; then
    echo -e "${RED}[ERROR] Unsupported Operating System or Package Manager!${NC}"
    echo -e "Detected OS: ${YELLOW}${OS_NAME} (ID: ${OS_ID})${NC}"
    echo ""
    echo -e "Supported package managers for automatic setup:"
    echo -e "  1. ${GREEN}Debian / Ubuntu (apt)${NC}    - Debian 12/13, Ubuntu 24.04-26.10, Mint, Pop!_OS"
    echo -e "  2. ${GREEN}Fedora / AlmaLinux (dnf)${NC} - Fedora 42-44, AlmaLinux 10"
    echo -e "  3. ${GREEN}openSUSE (zypper)${NC}        - openSUSE Leap 16, openSUSE Tumbleweed"
    echo -e "  4. ${GREEN}Arch Linux (pacman)${NC}      - Arch Linux, Manjaro, CachyOS, EndeavourOS"
    exit 1
fi

COCKPIT_PREINSTALLED=false
if is_cockpit_installed; then
    COCKPIT_PREINSTALLED=true
fi

PORT_9090_ACTIVE=false
PORT_9090_BINDINGS=""
if is_port_9090_listening; then
    PORT_9090_ACTIVE=true
    PORT_9090_BINDINGS=$(get_port_9090_listeners)
fi

echo -e "  -> Detected OS        : ${GREEN}${OS_NAME}${NC}"
echo -e "  -> Target Ecosystem   : ${GREEN}${ECOSYSTEM}${NC}"
if [ "$COCKPIT_PREINSTALLED" = true ]; then
    echo -e "  -> Existing Cockpit   : ${GREEN}Detected (will skip Cockpit installation and restart)${NC}"
else
    echo -e "  -> Existing Cockpit   : ${CYAN}Not detected${NC}"
fi
if [ "$PORT_9090_ACTIVE" = true ]; then
    echo -e "  -> Port 9090 Listener : ${GREEN}Active (${PORT_9090_BINDINGS:-detected}) (will preserve bindings)${NC}"
else
    echo -e "  -> Port 9090 Listener : ${CYAN}Free${NC}"
fi
echo ""

echo -e "${BLUE}[2/5] Installing required packages and system dependencies...${NC}"

PKGS=()
if [ "$COCKPIT_PREINSTALLED" = false ]; then
    PKGS+=(cockpit)
fi

case "$PKG_MANAGER" in
    apt)
        PKGS+=(btrfs-progs snapper cron git)
        export DEBIAN_FRONTEND=noninteractive
        echo -e "  -> Updating APT package lists..."
        apt-get update -qq
        echo -e "  -> Installing ${PKGS[*]} via APT..."
        apt-get install -y --no-install-recommends "${PKGS[@]}"
        ;;

    dnf)
        PKGS+=(btrfs-progs snapper cronie git)
        echo -e "  -> Installing ${PKGS[*]} via DNF..."
        dnf install -y "${PKGS[@]}"
        ;;

    zypper)
        PKGS+=(btrfsprogs snapper cronie git)
        echo -e "  -> Installing ${PKGS[*]} via Zypper..."
        zypper --non-interactive install --no-recommends -y "${PKGS[@]}"
        ;;

    pacman)
        PKGS+=(btrfs-progs snapper cronie git)
        echo -e "  -> Installing ${PKGS[*]} via Pacman..."
        pacman -S --needed --noconfirm "${PKGS[@]}"
        ;;
esac

echo -e "  -> ${GREEN}All dependencies installed successfully.${NC}"
echo ""

echo -e "${BLUE}[3/5] Verifying BTRFS kernel support and system services...${NC}"

if modprobe btrfs 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Active (Module loaded)${NC}"
elif grep -q "btrfs" /proc/filesystems 2>/dev/null; then
    echo -e "  -> BTRFS kernel driver       : ${GREEN}Active (Built-in kernel)${NC}"
else
    echo -e "  -> BTRFS kernel driver       : ${YELLOW}Warning: Could not verify btrfs in current kernel.${NC}"
fi

mkdir -p /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$COCKPIT_PREINSTALLED" = true ]; then
        echo -e "  -> Cockpit Web Console       : ${GREEN}Preserved (existing installation untouched)${NC}"
    elif [ "$PORT_9090_ACTIVE" = true ]; then
        echo -e "  -> Cockpit Web Console       : ${YELLOW}Skipped enabling cockpit.socket (port 9090 already active: ${PORT_9090_BINDINGS:-detected})${NC}"
    else
        systemctl enable --now cockpit.socket >/dev/null 2>&1 || true
        echo -e "  -> Cockpit Web Console       : ${GREEN}Enabled (cockpit.socket)${NC}"
    fi

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

    if systemctl list-unit-files | grep -q "^snapper-cleanup\.timer"; then
        systemctl enable --now snapper-cleanup.timer >/dev/null 2>&1 || true
        echo -e "  -> Snapper Cleanup Timer     : ${GREEN}Enabled (snapper-cleanup.timer)${NC}"
    fi
else
    echo -e "  -> ${YELLOW}Container or non-systemd environment detected. Service activation skipped.${NC}"
fi
echo ""

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

echo -e "${BLUE}[5/5] Finalizing permissions and verifying installation...${NC}"

chown -R root:root "$TARGET_DIR" 2>/dev/null || true
chmod -R u=rwX,go=rX "$TARGET_DIR"
chmod 755 "$TARGET_DIR/install.sh" 2>/dev/null || true
git config --system --add safe.directory "$TARGET_DIR" 2>/dev/null || true

echo ""
echo -e "${GREEN}======================================================================${NC}"
echo -e "${BOLD}${GREEN}  ✔ BTRFS Manager for Cockpit has been successfully installed!        ${NC}"
echo -e "${GREEN}======================================================================${NC}"
echo -e "  Installation Path : ${CYAN}${TARGET_DIR}${NC}"

if [ "$COCKPIT_PREINSTALLED" = true ]; then
    echo -e "  Cockpit Status    : ${GREEN}Existing installation & bindings preserved (no restart)${NC}"
    echo ""
    echo -e "  Getting Started:"
    echo -e "  1. Open or refresh your existing Cockpit Web Console in the browser."
    echo -e "  2. Select ${CYAN}BTRFS Manager${NC} in the left sidebar."
elif [ "$PORT_9090_ACTIVE" = true ]; then
    echo -e "  Cockpit Socket    : ${YELLOW}Not enabled automatically (port 9090 already in use: ${PORT_9090_BINDINGS:-detected})${NC}"
    echo ""
    echo -e "  Getting Started:"
    echo -e "  1. Configure a custom port or bind address if needed via:"
    echo -e "     ${YELLOW}sudo systemctl edit cockpit.socket${NC}"
    echo -e "  2. Enable Cockpit socket on your desired interface, then select ${CYAN}BTRFS Manager${NC} in the sidebar."
else
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    [ -z "$SERVER_IP" ] && SERVER_IP="localhost"
    echo -e "  Cockpit Web URL   : ${BOLD}${YELLOW}https://${SERVER_IP}:9090${NC}"
    echo ""
    echo -e "  Getting Started:"
    echo -e "  1. Open your browser and visit ${YELLOW}https://${SERVER_IP}:9090${NC}"
    echo -e "  2. Log in with your Linux credentials."
    echo -e "  3. Click ${CYAN}BTRFS Manager${NC} in the left sidebar."
fi

echo ""
echo -e "  To uninstall in the future:"
echo -e "    ${YELLOW}sudo ${TARGET_DIR}/install.sh --uninstall${NC}"
echo -e "${GREEN}======================================================================${NC}"
