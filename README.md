# Btrfs Manager for Cockpit

[![CI](https://github.com/NGxID18/Cockpit-BtrfsManager/actions/workflows/ci.yml/badge.svg)](https://github.com/NGxID18/Cockpit-BtrfsManager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A lightweight, zero-dependency web extension for **Cockpit** to inspect, configure, and maintain BTRFS storage pools directly from the Cockpit Web Console.

Designed to match Cockpit's native PatternFly 6 interface (`cockpit-storaged`, `cockpit-machines`, and `cockpit-network`) without Node.js build pipelines, external frameworks, or background daemons.

---

## Interface Preview

| **1. Storage Pools Overview** |
| :---: |
| <img width="2559" height="1267" alt="Cockpit-BtrfsManager Dashboard" src="https://github.com/user-attachments/assets/152a34e7-13f9-412a-ab23-179de4d3240c" /> |
| *Master view displaying active BTRFS storage pools, hardware models, mount points, Data/Metadata profiles, automatic backup status, and inline usage bars.* |

<br />

| **2. Pool Detail, Health & Subvolumes Workspace** |
| :---: |
| <img width="2559" height="1267" alt="Cockpit-BtrfsManager Detail" src="https://github.com/user-attachments/assets/29639fa7-8270-4b97-9d1c-ae43c75e9463" /> |
| *Detail view featuring pool properties, RAID profile actions, health diagnostics, maintenance controls (`scrub`, `balance`, `defragment`), and the tabbed Subvolumes / Snapshots / Member drives workspace.* |

---

## Key Features

- **Storage Pool Dashboard**: At-a-glance cards displaying member hardware, mount points, dominant Data/Metadata RAID profiles, automatic backup status, drive error indicators, and compact inline usage bars.
- **Pool Creation & Online Profile Conversion**: Format unallocated drives or partitions (`>= 256 MiB`) into BTRFS pools (`SINGLE`, `DUP`, `RAID0`, `RAID1`, `RAID10`) and convert Data (`SINGLE`, `DUP`, `RAID0`, `RAID1`, `RAID10`) or Metadata (`DUP`, `SINGLE`, `RAID1`, `RAID10`) profiles online.
- **Subvolume Tree & CoW Control**: Discover mounted and unmounted subvolumes from top-level `subvolid=5`, create nested subvolumes, toggle Copy-on-Write (`+CoW` / `NoCoW` via `chattr`), and remove unused subvolumes safely.
- **Snapshots & Automated Retention Backups**: Take snapshots of the pool root, lock/unlock read-only flags (`btrfs property set`), clone snapshots back to writable subvolumes, schedule `hourly`, `daily`, or `weekly` Snapper backups with configurable retention limits, and detect stale/orphaned Snapper configs.
- **Online Maintenance & Diagnostics**: Run `btrfs scrub`, `btrfs balance`, recursive `defragment`, and `btrfs device stats` directly from an auto-revealing live maintenance console with background status polling.
- **Multi-Layer OS Root & Deletion Guards**:
  - Blocks deletion of the host OS root (`/`) storage pool.
  - Verifies active VFS mounts and `/etc/fstab` entries before deleting any subvolume.
  - Requires explicit pool-name confirmation before wiping drives on non-root pools.

---

## Architecture & Technical Highlights

- **Zero-Dependency Vanilla JS & PatternFly 6 Integration**  
  Communicates directly with system CLI utilities over Cockpit's native `cockpit.spawn()` D-Bus/bridge (`base1/cockpit.js`) and adapts dynamically to Cockpit's light/dark theme via `cockpit-style` events and `shell:style` storage synchronization.
- **Strict Content Security Policy (`default-src 'self'`) Compliance**  
  Operates cleanly under `cockpit-ws`'s default CSP without `unsafe-inline` styles: capacity meters render via inline SVG geometry attributes (`<svg>`/`<rect>`), nested subvolume depth uses static CSS indentation classes, and native `<select>` elements are enhanced by a pure JS PatternFly 6 `window.Dropdown` controller (`src/helper.js`).
- **Isolated Top-Level Tree Inspection (`subvolid=5`)**  
  Mounts the filesystem's top-level tree (`subvolid=5`) into a temporary directory protected by an `EXIT` cleanup trap (`Sh.mountTopLevel` in `src/helper.js`), allowing complete management of unmounted subvolumes and `.snapshots` without altering system mount points.
- **Hardened Command Execution & Permissions**  
  Privileged system calls run through `cockpit.spawn([...], { superuser: "require", environ: ["LC_ALL=C.UTF-8", "LANG=C.UTF-8"] })` using argument arrays where applicable, strict path-segment sanitization (`@`, alphanumeric, dots, dashes, underscores), and least-privilege installation ownership (`root:root`, `u=rwX,go=rX`).

---

## Project Structure

| File | Purpose |
| :--- | :--- |
| `manifest.json` | Cockpit plugin manifest registering `Btrfs Manager` under Tools |
| `index.html` | Page layout container, pool creation form, and modal dialogs |
| `style.css` | PatternFly 6 light/dark CSS tokens, Cockpit page frame, cards, tables, SVG bars, and custom dropdown styling |
| `src/helper.js` | DOM utilities, byte size formatters, `cockpit.spawn` wrapper (`cmd`), bash helpers (`Sh`), `Dropdown`, and `Modal` controllers |
| `src/engine.js` | System discovery (`btrfs`, `findmnt`, `lsblk`, `snapper`), metric polling, orphan backup detection, and Master/Detail UI rendering |
| `src/router.js` | Delegated action router, online scrub/balance background monitors, theme listener, validation guards, and self-updater |
| `install.sh` | Cross-distro installer/uninstaller supporting `apt`, `dnf`, `zypper`, and `pacman` |
| `LICENSE` | MIT License terms and copyright notice |
| `.github/workflows/ci.yml` | Automated CI pipeline for shell, JS, CSS, and CSP verification |
| `.github/workflows/release.yml` | Automated package builder attaching `.deb` and `.rpm` releases |

---

## Tested Distributions

> [!NOTE]
> Any Linux distribution with `cockpit`, `btrfs-progs`, `snapper`, `cron`/`cronie`, and `git` can run this extension alongside standard base Linux utilities (`util-linux`, `e2fsprogs`, POSIX `awk`).

- **Debian / Ubuntu (`apt`)**: Debian 12 & 13, Ubuntu 24.04 LTS – 26.10, Linux Mint, Pop!_OS
- **Fedora / AlmaLinux (`dnf`)**: Fedora 42 – 44, AlmaLinux 10
- **openSUSE (`zypper`)**: openSUSE Leap 16, openSUSE Tumbleweed
- **Arch Linux (`pacman`)**: Arch Linux, Manjaro, CachyOS, EndeavourOS

---

## Quick Installation

### Option A: Automated Installer Script (All Distros)

Run either command as `root` (or with `sudo`) to detect your distribution, install dependencies, and deploy to `/usr/share/cockpit/btrfsmanager`:

```bash
curl -sSL https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

```bash
wget -qO- https://raw.githubusercontent.com/NGxID18/Cockpit-BtrfsManager/main/install.sh | sudo bash
```

### Option B: Native `.deb` / `.rpm` Packages (GitHub Releases)

Download the pre-built `.deb` or `.rpm` package from [GitHub Releases](https://github.com/NGxID18/Cockpit-BtrfsManager/releases/latest):

- **Debian / Ubuntu (`apt`)**:
  ```bash
  sudo apt install ./cockpit-btrfs-manager_*_all.deb
  ```
- **Fedora / AlmaLinux (`dnf`)**:
  ```bash
  sudo dnf install ./cockpit-btrfs-manager-*.noarch.rpm
  ```
- **openSUSE (`zypper`)**:
  ```bash
  sudo zypper install --allow-unsigned-rpm ./cockpit-btrfs-manager-*.noarch.rpm
  ```

Once installed, open Cockpit at `https://<server-ip>:9090`, sign in, and select **Btrfs Manager** from the sidebar.

---

## Manual Installation

If you prefer reviewing or running each setup step manually instead of executing the installer script:

### 1. Install Required System Dependencies

Only the 5 essential packages are required (`cockpit`, `btrfs-progs`/`btrfsprogs`, `snapper`, `cron`/`cronie`, and `git`). Standard base system utilities (`util-linux`, `e2fsprogs` for `chattr`/`lsattr`, and POSIX `awk`/`sed`/`grep`) are already included by default on Linux distributions.

#### Debian / Ubuntu (`apt`)
```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends cockpit btrfs-progs snapper cron git
```

#### Fedora / AlmaLinux (`dnf`)
```bash
sudo dnf install -y cockpit btrfs-progs snapper cronie git
```

#### openSUSE (`zypper`)
```bash
sudo zypper install --no-recommends -y cockpit btrfsprogs snapper cronie git
```

#### Arch Linux (`pacman`)
```bash
sudo pacman -S --needed cockpit btrfs-progs snapper cronie git
```

### 2. Enable Cockpit & Background Services

Ensure the BTRFS kernel module and required systemd units are active:

```bash
sudo modprobe btrfs 2>/dev/null || true
sudo mkdir -p /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly
sudo systemctl enable --now cockpit.socket
sudo systemctl enable --now cron.service 2>/dev/null || sudo systemctl enable --now crond.service 2>/dev/null || sudo systemctl enable --now cronie.service
sudo systemctl enable --now snapper-cleanup.timer 2>/dev/null || true
```

### 3. Clone into Cockpit's Extension Directory

```bash
sudo mkdir -p /usr/share/cockpit
sudo git clone --depth 1 https://github.com/NGxID18/Cockpit-BtrfsManager.git /usr/share/cockpit/btrfsmanager
sudo chown -R root:root /usr/share/cockpit/btrfsmanager
sudo chmod -R u=rwX,go=rX /usr/share/cockpit/btrfsmanager
sudo chmod 755 /usr/share/cockpit/btrfsmanager/install.sh
sudo git config --system --add safe.directory /usr/share/cockpit/btrfsmanager
sudo systemctl try-restart cockpit.service
```

---

## Uninstallation

Remove the extension and clean up scheduled cron backup scripts:

```bash
sudo /usr/share/cockpit/btrfsmanager/install.sh --uninstall
```

---

## Scope & Safety Notes

- **Mounting & `/etc/fstab`**: Filesystem mounting and persistent `/etc/fstab` edits are intentionally left to Cockpit's native **Storage** module to avoid duplicate unit/mount management conflicts.
- **Eligible Drives**: Pool creation and drive expansion (`Add drive`) list only unformatted, unmounted `disk`/`part` block devices of at least `256 MiB` (excluding active pool members and `zram`).

---

## License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for full details.

