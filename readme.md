# BTRFS Manager for Cockpit

## Project Details
BTRFS Manager is a lightweight, native web interface extension for the Cockpit Project. It is designed to provide comprehensive management of BTRFS filesystems directly from your web browser. 

Built entirely with Vanilla JavaScript, HTML, and custom CSS, this extension closely mimics the native PatternFly design system utilized by Cockpit—including automatic Dark Mode support—without requiring complex build tools, Node.js, or NPM. 

By leveraging Cockpit's native `spawn` API, the extension communicates directly with the system's command-line utilities. This ensures maximum portability, zero backend daemon requirements, and immediate execution of advanced filesystem commands.

### Core Features
* Master-Detail Dashboard: A responsive grid layout that provides a high-level overview of all BTRFS volumes, with dedicated detail pages for advanced management.
* Volume & RAID Creation: Format empty block devices into new BTRFS volumes with support for Single, DUP, RAID 0, RAID 1, and RAID 10 profiles, with strict safety checks for unallocated disks.
* Volume Deletion & Teardown: Safely destroy non-root BTRFS pools with automated unmounting, full Snapper/Cron snapshot schedule purge, and disk signature wipe (`wipefs`).
* Orphaned Snapshot Cleaner: Automatically detects broken or stale Snapper configs pointing to removed drives and provides 1-click cleanup to prevent systemwide snapshot failures.
* Physical Device Management: View physical device topology, add new blank disks online, remove disks, and easily evacuate disconnected/failed drives with missing-device recovery.
* Device Health & Diagnostics: Real-time monitoring of disk I/O and checksum corruption counters (`btrfs device stats`) to catch failing hardware before data loss occurs.
* Subvolumes & Snapshots: Create and delete subvolumes with granular controls (CoW toggle, Read-Only locking, defragmentation). Take instant snapshots, restore/clone them to read-write subvolumes, or rollback the default mount.
* Storage Breakdown & Features: Visual progress bars for Data and Metadata chunk allocation with usage warnings, alongside auto-detection of compression algorithms (`zstd`, `lzo`) and mount features.
* Maintenance & Optimization: Non-blocking background scrub and balance with live terminal tracking, multi-volume concurrency, and targeted subvolume defragmentation.

## Supported Linux Ecosystems
Official compatibility is guaranteed for the following Linux distributions and their derivatives:
* **Debian Ecosystem (`apt`)**: Debian, Ubuntu, Linux Mint, Pop!_OS, Proxmox VE, Kali Linux, Zorin OS, etc.
* **RHEL / Fedora Ecosystem (`dnf`)**: Fedora, RHEL, Rocky Linux, AlmaLinux, CentOS Stream, Nobara, etc.
* **Arch Linux Ecosystem (`pacman`)**: Arch Linux, Manjaro, EndeavourOS, CachyOS, Garuda Linux, etc.

## Quick Installation (Recommended — Fresh OS Ready)
Run the following one-line command to automatically detect your OS, install all required dependencies (`cockpit`, `btrfs-progs`, `snapper`, `cron`/`cronie`, core utilities), enable services, and install **BTRFS Manager** into `/usr/share/cockpit/btrfs-manager`:

```bash
curl -sSL https://raw.githubusercontent.com/NGxID18/btrfs-manager/main/install.sh | sudo bash
```

## Manual Installation
If you prefer to install manually, ensure the following packages are installed on your system:

* `cockpit`: The core Cockpit web console (`cockpit.socket` enabled).
* `btrfs-progs`: BTRFS filesystem management CLI tools.
* `util-linux` & `e2fsprogs`: Provides `lsblk`, `findmnt`, `blkid`, `wipefs`, `lsattr`, and `chattr`.
* `snapper` & `cron`/`cronie`: Required for automated scheduled snapshots, retention limits, and cleanup schedules.
  * **Debian / Ubuntu**: `sudo apt install cockpit btrfs-progs snapper cron anacron util-linux e2fsprogs git`
  * **Fedora / RHEL**: `sudo dnf install cockpit btrfs-progs snapper cronie cronie-anacron util-linux e2fsprogs git`
  * **Arch Linux**: `sudo pacman -S cockpit btrfs-progs snapper cronie util-linux e2fsprogs git`

Then clone the repository into your Cockpit extensions directory:

### System-wide (all users)
```bash
sudo git clone https://github.com/NGxID18/btrfs-manager /usr/share/cockpit/btrfs-manager
```

### User-only (no root required)
```bash
git clone https://github.com/NGxID18/btrfs-manager ~/.local/share/cockpit/btrfs-manager
```

After installation, log in to Cockpit (`https://<server-ip>:9090`) and select **BTRFS** from the sidebar.

## Usage Notes
* **Master View**: Provides a dashboard grid of all detected BTRFS pools, showing raw size, usable space, active RAID profiles, and snapshot schedules.
* **Detail View**: Click "Manage Volume" on any volume card to access device topology, subvolume tree, snapshot history, and maintenance controls.
* **Device Selection**: Only unallocated disks without existing filesystems or active mount points are shown when creating volumes or adding disks.
* **System Root Protection**: The operating system root pool (`/`) cannot be destroyed or wiped from the UI.
* **Rollbacks**: To rollback to a snapshot, click **Set as Default Mount** on the target snapshot subvolume.
