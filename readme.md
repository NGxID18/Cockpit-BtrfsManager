# BTRFS Manager for Cockpit

## Project Details
BTRFS Manager is a lightweight, native web interface extension for the Cockpit Project. It is designed to provide comprehensive management of BTRFS filesystems directly from your web browser.

Built entirely with Vanilla JavaScript, HTML, and custom CSS, this extension closely mimics the native PatternFly design system utilized by Cockpit—including Light and Dark theme support—without requiring complex build tools, Node.js, or NPM.

By leveraging Cockpit's native `spawn` API, the extension communicates directly with the system's command-line utilities. This ensures maximum portability, zero backend daemon requirements, and immediate execution of advanced filesystem commands.

### Core Features
* **Master-Detail Dashboard**: A responsive grid layout providing a high-level overview of all BTRFS storage pools, with dedicated detail views for topology, subvolume, snapshot, and maintenance operations.
* **Pool & RAID Creation**: Format empty block devices into new BTRFS storage pools with independent Data and Metadata protection profiles (`Single`, `DUP`, `RAID 0`, `RAID 1`, `RAID 10`) and strict safety checks for unallocated disks.
* **Pool Deletion & Teardown**: Safely destroy non-root BTRFS pools with automated unmounting, Snapper/Cron backup schedule cleanup, `/etc/fstab` warnings, and disk signature wiping (`wipefs`).
* **Stale Backup Schedule Cleaner**: Automatically detects orphaned Snapper configurations pointing to removed drives or deleted subvolumes and provides 1-click cleanup.
* **Physical Device & Protection Management**: View physical device topology, add new empty drives online, remove drives, evacuate missing drives from degraded pools, and convert Data or Metadata RAID profiles online (including 1-click Metadata `SINGLE` to `DUP` upgrade).
* **Drive Health & Diagnostics**: Real-time monitoring of disk I/O and checksum corruption counters (`btrfs device stats`) to detect failing hardware early.
* **Subvolumes & Snapshots**: Create subvolumes (including nested paths), toggle Copy-on-Write (`+CoW` / `NoCoW`), and delete unused subvolumes with built-in protection for active mounts and `/etc/fstab` entries. Take instant snapshots, lock/unlock snapshots (`Read-Only` / `Writable`), restore snapshots into new writable subvolumes, and configure automated Cron + Snapper retention schedules (`Hourly`, `Daily`, `Weekly`).
* **Storage Breakdown & Active Features**: Visual progress bars for Data and Metadata chunk allocations with usage thresholds, alongside auto-detection of active mount options (`compress`, `space_cache`, `discard`, `ssd`, `autodefrag`).
* **Optimization & Maintenance**: Non-blocking background scrub (`Verify & Repair`) and balance (`Optimize Space`) with live terminal tracking, multi-pool concurrency, recursive defragmentation, and on-demand drive diagnostics.

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
* **Master View**: Displays a dashboard grid of all detected BTRFS storage pools, showing raw capacity, usable space, Data/Metadata profiles, chunk allocation bars, and automated backup status.
* **Detail View**: Click **Manage Storage Pool** on any pool card to manage member drives, protection profiles, subvolumes, snapshots, and maintenance tasks.
* **Mounting Pools**: Mounting and `/etc/fstab` configuration are intentionally handled by Cockpit's native **Storage** (`cockpit-storaged`) module to avoid service conflicts.
* **Device Selection**: Only unallocated drives/partitions (>= 256 MiB) without existing filesystems or active mount points are listed when creating pools or adding drives.
* **System Root Protection**: The operating system root pool (`/`) and actively mounted or `/etc/fstab`-referenced subvolumes are protected from deletion in the UI.
* **Restoring Snapshots**: To restore a snapshot, click **Restore** on the target snapshot row to clone it into a new writable subvolume.
