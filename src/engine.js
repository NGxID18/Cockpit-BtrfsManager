/**
 * BTRFS Manager - Core Engine & State Controller
 * Handles topology discovery, storage parsing, metrics collection, and DOM rendering.
 */

/**
 * Parses raw "btrfs filesystem df" output to calculate allocation percentages and total/used sizes.
 */
const parseChunkAlloc = (dfText, type) => {
  const regex = new RegExp(`${type},\\s*([^:]+):\\s*total=([^,]+),\\s*used=([^\\n]+)`, "gi");
  const matches = [...dfText.matchAll(regex)];
  if (!matches.length) return null;

  let totalBytes = 0;
  let usedBytes = 0;
  let dominantProfile = matches[0][1].trim().toUpperCase();
  let maxAllocated = -1;

  for (const match of matches) {
    const tBytes = parseSize(match[2].trim());
    const uBytes = parseSize(match[3].trim());
    totalBytes += tBytes;
    usedBytes += uBytes;

    if (tBytes > maxAllocated) {
      maxAllocated = tBytes;
      dominantProfile = match[1].trim().toUpperCase();
    }
  }

  const percentUsed = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 100)) : 0;
  return {
    profile: dominantProfile,
    totalStr: matches.length === 1 ? matches[0][2].trim() : formatSize(totalBytes),
    usedStr: matches.length === 1 ? matches[0][3].trim() : formatSize(usedBytes),
    pct: percentUsed,
  };
};

window.App = {
  vols: [],
  hw: {},
  mnt: {},
  rootDevs: new Set(),
  hasSnapper: false,
  orphanedSnaps: [],

  /**
   * Scans system storage topology, block devices, active mount points, and Snapper status.
   */
  async fetch() {
    const masterView = $("view-master");
    const diskContainer = $("disk-container");

    if (masterView && !masterView.classList.contains("hidden-element") && diskContainer) {
      diskContainer.innerHTML = "<p class='loading-text'>Scanning BTRFS &amp; Hardware Topologies...</p>";
    }

    try {
      const [btrfsOut, mntOut, lsblkOut, snapperCheck, rootDeviceOut] = await Promise.all([
        cmd(["btrfs", "filesystem", "show"]),
        cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
        cmd(["lsblk", "-J", "-o", "NAME,PATH,MODEL,VENDOR,TYPE"]).catch(() => "{}"),
        cmd(["sh", "-c", "command -v snapper >/dev/null 2>&1 && echo yes || echo no"]).catch(() => "no"),
        cmd(["findmnt", "-n", "-o", "SOURCE", "-T", "/"]).catch(() => ""),
      ]);

      this.hasSnapper = (snapperCheck || "").trim() === "yes";
      this.mnt = {};
      this.rootDevs = new Set();

      // Reliable detection of host root disk (preserves OS pool from accidental deletion)
      const cleanRootDev = (rootDeviceOut || "").trim().split("[")[0];
      if (cleanRootDev) this.rootDevs.add(cleanRootDev);

      // Map active BTRFS mounts
      const walkMounts = (nodes) => {
        nodes.forEach((node) => {
          if (node.source && node.target) {
            const baseDev = node.source.split("[")[0];
            if (node.target === "/" || node.target === "/sysroot") {
              this.rootDevs.add(baseDev);
            }
            if (!this.mnt[baseDev] || node.target.length < this.mnt[baseDev].length) {
              this.mnt[baseDev] = node.target;
            }
            this.mnt[node.source] = node.target;
          }
          if (node.children) walkMounts(node.children);
        });
      };
      walkMounts(JSON.parse(mntOut).filesystems || []);

      // Map hardware device model names
      this.hw = {};
      const walkHw = (nodes, parentModel) => {
        nodes.forEach((node) => {
          const model = [node.vendor, node.model].filter(Boolean).join(" ").trim() || parentModel;
          if (node.path) this.hw[node.path] = model || "Generic Storage";
          if (node.children) walkHw(node.children, model);
        });
      };
      walkHw(JSON.parse(lsblkOut).blockdevices || []);

      await this.parseBtrfs(btrfsOut);
    } catch (err) {
      if (diskContainer) {
        diskContainer.innerHTML = `<p class="text-danger mt-15">Scan Error: ${escapeHtml(err.message)}</p>`;
      }
    }
  },

  /**
   * Parses output from "btrfs filesystem show" into structured storage pool models.
   */
  async parseBtrfs(output) {
    this.vols = output
      .split(/Label:\s+/i)
      .filter((block) => block.trim() !== "" && /uuid:\s+[a-f0-9-]+/i.test(block))
      .map((block, idx) => {
        const labelMatch = block.match(/^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9-]+)/i);
        const uuid = labelMatch ? labelMatch[3] : "Unknown";
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/i);
        const rootPath = pathMatch ? pathMatch[1] : "";
        const blockHasMissing = /\*\*\*\s*Some devices missing/i.test(block);

        const devs = [];
        block.split("\n").forEach((line) => {
          if (/devid/i.test(line) && (/path/i.test(line) || /MISSING/i.test(line))) {
            const idMatch = line.match(/devid\s+(\d+)/i);
            const sizeMatch = line.match(/size\s+([0-9.]+(?:[a-zA-Z]+)?)/i);
            const devPathMatch = line.match(/path\s+(\S+)/i);
            const isMissing = /\bMISSING\b/i.test(line);

            if (idMatch && (devPathMatch || isMissing)) {
              const devPath =
                devPathMatch && devPathMatch[1] !== "MISSING" ? devPathMatch[1] : "MISSING";
              devs.push({
                id: idMatch[1],
                size: sizeMatch ? sizeMatch[1] : "0",
                path: devPath,
                missing: isMissing,
              });
            }
          }
        });

        // Determine mount point
        let mountPoint = (rootPath && this.mnt[rootPath]) || "";
        if (!mountPoint) {
          for (const d of devs) {
            if (this.mnt[d.path]) {
              mountPoint = this.mnt[d.path];
              break;
            }
          }
        }

        const rawSize = formatSize(devs.reduce((sum, d) => sum + parseSize(d.size), 0));
        const hwList =
          [...new Set(devs.map((d) => this.hw[d.path]))].filter(Boolean).join(" & ") ||
          "Standard Storage Device";

        const poolLabel =
          labelMatch && (labelMatch[1] || labelMatch[2]) !== "none"
            ? labelMatch[1] || labelMatch[2]
            : `Storage Pool (${uuid.slice(0, 8)})`;

        return {
          idx,
          label: poolLabel,
          uuid,
          mountPoint,
          devs,
          hasMissing: blockHasMissing || devs.some((d) => d.missing),
          rawSize,
          hwList,
          raid: "Loading...",
          usable: "Loading...",
          snapStatus: "Loading...",
          dataAlloc: null,
          metaAlloc: null,
          mountOptsHtml: "",
          healthHtml: "",
          devErrors: {},
          totalDevErrors: 0,
        };
      });

    this.renderMaster();

    // Preserve active detail view if user was viewing a pool
    const activeIdx = $("detail-container")?.getAttribute("data-active-index");
    if (activeIdx !== null && activeIdx !== "" && !$("view-detail")?.classList.contains("hidden-element")) {
      const activeVol = this.vols.find((v) => v.idx == activeIdx);
      if (activeVol) {
        this.updateUI(activeVol);
      } else {
        $("view-detail").classList.add("hidden-element");
        $("view-master").classList.remove("hidden-element");
        $("detail-container").setAttribute("data-active-index", "");
      }
    }

    await this.fetchDynamicMetrics();
  },

  /**
   * Scans for orphaned Snapper configs pointing to deleted folders or drives.
   */
  async checkOrphanedSnapshots() {
    try {
      const script = `
if command -v snapper >/dev/null 2>&1; then
  snapper list-configs 2>/dev/null | awk 'NR>2 {print $1 "|" $3}' | while IFS="|" read -r cfg subvol; do
    [ -z "$cfg" ] || [ "$cfg" = "Config" ] && continue
    is_orphan=0
    if [ -z "$subvol" ] || [ ! -d "$subvol" ]; then
      is_orphan=1
    elif ! btrfs subvolume show "$subvol" >/dev/null 2>&1; then
      tgt=$(findmnt -n -o TARGET -T "$subvol" 2>/dev/null)
      if [ "$tgt" != "$subvol" ] && [ "$subvol" != "/" ]; then
        is_orphan=1
      elif ! findmnt -n -t btrfs -T "$subvol" >/dev/null 2>&1; then
        is_orphan=1
      fi
    fi
    [ "$is_orphan" -eq 1 ] && echo "$cfg|$subvol"
  done
fi
`;
      const out = await cmd(["sh", "-c", script]);
      this.orphanedSnaps = out
        .trim()
        .split("\n")
        .filter((line) => line.trim().includes("|"))
        .map((line) => {
          const [cfg, subvol] = line.split("|");
          return { cfg: cfg.trim(), subvol: (subvol || "").trim() };
        });
    } catch {
      this.orphanedSnaps = [];
    }
    this.renderOrphanBanner();
  },

  /**
   * Displays banner warning when stale/orphaned backup schedules are detected.
   */
  renderOrphanBanner() {
    const el = $("orphan-snap-container");
    if (!el) return;

    if (!this.orphanedSnaps?.length) {
      el.classList.add("hidden-element");
      el.innerHTML = "";
      return;
    }

    const count = this.orphanedSnaps.length;
    const itemsHtml = this.orphanedSnaps
      .map(
        (o) =>
          `<li><strong>${escapeHtml(o.cfg)}</strong> (Target: <span class="btrfs-code">${escapeHtml(o.subvol || "Missing")}</span>)</li>`,
      )
      .join("");

    el.innerHTML = `
      <div class="orphan-snap-content">
        <div class="orphan-snap-title">
          <span>⚠️ Stale Backup Schedules Found</span>
          <span class="orphan-badge">${count} Stale ${count === 1 ? "Schedule" : "Schedules"}</span>
        </div>
        <div class="orphan-snap-desc">
          The following automatic backup schedules point to folders or drives that no longer exist. Removing them will prevent backup errors:
        </div>
        <ul class="danger-list orphan-item-list">${itemsHtml}</ul>
      </div>
      <div class="orphan-snap-actions">
        <button class="btn btn-danger btn-sm btn-action" data-action="clean-orphaned-snaps">Remove Stale Schedules</button>
      </div>
    `;
    el.classList.remove("hidden-element");
  },

  /**
   * Fetches real-time space usage, active mount options, device corruption stats, and backup status.
   */
  async fetchDynamicMetrics() {
    const snapScript = `
MNT="$1"
STATUS="Not Configured"
CFG=""
if command -v snapper >/dev/null 2>&1; then
  CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
fi

CRON=""
for cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  [ -d "$cdir" ] || continue
  for cf in "$cdir"/btrfs_*; do
    [ -f "$cf" ] || continue
    if grep -qxF "# Target: $MNT" "$cf" 2>/dev/null || { [ -n "$CFG" ] && [ "$CFG" != "Config" ] && { [ "$(basename "$cf")" = "btrfs_snap_$CFG" ] || grep -qxF "# Config: $CFG" "$cf" 2>/dev/null; }; }; then
      CRON="$cf"
      break 2
    fi
  done
done

if [ -n "$CRON" ]; then
  FRQ=$(echo "$CRON" | awk -F'/' '{print $3}' | sed 's/cron\\.//' | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
  LIM=$(grep -E "^# Limit:" "$CRON" 2>/dev/null | awk '{print $3}')
  if [ -z "$LIM" ] && [ -n "$CFG" ] && [ "$CFG" != "Config" ] && command -v snapper >/dev/null 2>&1; then
    LIM=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="NUMBER_LIMIT"{print $3}')
  fi
  STATUS="$FRQ (\${LIM:-5} backups kept)"
elif [ -n "$CFG" ] && [ "$CFG" != "Config" ] && command -v snapper >/dev/null 2>&1; then
  IS_ON=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_CREATE"{print $3}')
  if [ "$IS_ON" = "yes" ]; then
    STATUS="Enabled (Active)"
  fi
fi
echo "$STATUS"
`;

    await Promise.all([
      this.checkOrphanedSnapshots(),
      ...this.vols.map(async (v) => {
        if (!v.mountPoint) {
          v.raid = "Mount required";
          v.usable = "Locked (Not Mounted)";
          v.snapStatus = "Locked";
          this.updateUI(v);
          return;
        }

        try {
          const [dfOut, hOut, snapOut, optsOut, statsOut] = await Promise.all([
            cmd(["btrfs", "filesystem", "df", v.mountPoint]),
            cmd(["df", "-B1", "--output=size,avail", v.mountPoint]),
            cmd(["sh", "-c", snapScript, "--", v.mountPoint]).catch(() => "Not Configured"),
            cmd(["findmnt", "-n", "-o", "OPTIONS", "-T", v.mountPoint]).catch(() => ""),
            cmd(["btrfs", "device", "stats", v.mountPoint]).catch(() => ""),
          ]);

          // Parse mount options
          if (optsOut) {
            const rawOpts = optsOut.trim().split(",");
            const highlightedOpts = [];
            ["compress", "space_cache", "discard"].forEach((prefix) => {
              const found = rawOpts.find((o) => o.startsWith(prefix));
              if (found) highlightedOpts.push(found);
            });
            if (rawOpts.includes("ro")) highlightedOpts.push("read-only");
            if (rawOpts.includes("ssd")) highlightedOpts.push("ssd");
            if (rawOpts.includes("autodefrag")) highlightedOpts.push("autodefrag");

            v.mountOptsHtml = highlightedOpts.length
              ? highlightedOpts
                  .map((opt) => `<span class="mount-opt-tag">${escapeHtml(opt)}</span>`)
                  .join(" ")
              : '<span class="text-muted">Standard options</span>';
          } else {
            v.mountOptsHtml = '<span class="text-muted">Default</span>';
          }

          // Parse drive corruption statistics
          let totalDevErrors = 0;
          const devErrors = {};
          if (statsOut) {
            statsOut
              .trim()
              .split("\n")
              .forEach((line) => {
                const match = line.match(/\[([^\]]+)\]\.(\w+)\s+(\d+)/);
                if (match) {
                  const devPath = match[1];
                  const count = parseInt(match[3], 10) || 0;
                  devErrors[devPath] = (devErrors[devPath] || 0) + count;
                  totalDevErrors += count;
                }
              });
          }
          v.devErrors = devErrors;
          v.totalDevErrors = totalDevErrors;
          v.healthHtml =
            totalDevErrors > 0
              ? `<span class="text-danger fw-bold">⚠️ ${totalDevErrors} Disk Error(s) Detected!</span>`
              : `<span class="text-success fw-bold">✓ Healthy (No Errors)</span>`;

          // Chunk allocations
          v.dataAlloc = parseChunkAlloc(dfOut, "Data");
          v.metaAlloc = parseChunkAlloc(dfOut, "Metadata");

          const dataProfile = v.dataAlloc?.profile || dfOut.match(/Data,\s*(.*?):/i)?.[1]?.toUpperCase() || "SINGLE";
          const metaProfile = v.metaAlloc?.profile || dfOut.match(/Metadata,\s*(.*?):/i)?.[1]?.toUpperCase() || "DUP";
          v.raid = `<span class="btrfs-code">Data: ${escapeHtml(dataProfile)}</span> <span class="btrfs-code">Meta: ${escapeHtml(metaProfile)}</span>`;

          // Usable vs Raw size
          const dfLines = hOut.trim().split("\n");
          if (dfLines.length > 1) {
            const cols = dfLines[1].trim().split(/\s+/);
            const totalBytes = parseInt(cols[0], 10) || 0;
            const availBytes = parseInt(cols[1], 10) || 0;
            v.usable = `${formatSize(availBytes)} free of ${formatSize(totalBytes)}`;
          } else {
            v.usable = "Unknown";
          }

          v.snapStatus = snapOut.trim() || "Not Configured";
        } catch {
          v.raid = "Error Reading Profile";
          v.usable = "Error";
          v.snapStatus = "Error";
        }

        this.updateUI(v);
      }),
    ]);
  },

  /**
   * Renders visual allocation progress bars for Data and Metadata chunks.
   */
  renderAllocBars(v, isDetail = false) {
    if (!v.mountPoint || !v.dataAlloc || !v.metaAlloc) return "";
    const d = v.dataAlloc;
    const m = v.metaAlloc;

    const dataClass = d.pct >= 90 ? "danger" : d.pct >= 75 ? "warn" : "data";
    const metaClass = m.pct >= 85 ? "danger" : m.pct >= 70 ? "warn" : "meta";

    return `
      <div class="${isDetail ? "alloc-section mb-15" : "alloc-section mt-10 mb-15"}">
        <div class="alloc-section-title">
          <span>${isDetail ? "Storage Chunk Allocation" : "Chunk Allocation"}</span>
          ${isDetail ? '<span class="text-muted text-sm">Raw BTRFS chunks</span>' : ""}
        </div>
        <div class="alloc-bar-group">
          <div class="alloc-bar-header">
            <span class="alloc-bar-title">Data <span class="btrfs-code">${escapeHtml(d.profile)}</span></span>
            <span class="alloc-bar-stats">${escapeHtml(d.usedStr)} / ${escapeHtml(d.totalStr)} (${d.pct}%)</span>
          </div>
          <div class="alloc-bar-track">
            <div class="alloc-bar-fill ${dataClass}" style="width: ${d.pct}%;"></div>
          </div>
        </div>
        <div class="alloc-bar-group">
          <div class="alloc-bar-header">
            <span class="alloc-bar-title">Metadata <span class="btrfs-code">${escapeHtml(m.profile)}</span>${
              m.profile === "SINGLE" && v.mountPoint
                ? ` <button class="btn-xs-tag btn-action" data-action="quick-meta-dup" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}" title="Upgrade metadata from Single to DUP for corruption safety">Upgrade to DUP</button>`
                : ""
            }</span>
            <span class="alloc-bar-stats">${escapeHtml(m.usedStr)} / ${escapeHtml(m.totalStr)} (${m.pct}%)</span>
          </div>
          <div class="alloc-bar-track">
            <div class="alloc-bar-fill ${metaClass}" style="width: ${m.pct}%;"></div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Refreshes dynamic metric widgets in both Master and Detail views without full DOM re-renders.
   */
  updateUI(v) {
    if ($(`master-usable-${v.idx}`)) {
      $(`master-usable-${v.idx}`).textContent = v.usable;
      if ($(`master-snap-${v.idx}`)) $(`master-snap-${v.idx}`).textContent = v.snapStatus;
      if ($(`master-raid-${v.idx}`)) $(`master-raid-${v.idx}`).innerHTML = v.raid;
      if ($(`master-alloc-${v.idx}`)) $(`master-alloc-${v.idx}`).innerHTML = this.renderAllocBars(v, false);
    }
    if ($(`raid-display-${v.idx}`)) {
      $(`raid-display-${v.idx}`).innerHTML = v.raid;
      $(`usable-display-${v.idx}`).textContent = v.usable;
      if ($(`snap-display-${v.idx}`)) $(`snap-display-${v.idx}`).textContent = v.snapStatus;
      if ($(`health-display-${v.idx}`)) $(`health-display-${v.idx}`).innerHTML = v.healthHtml;
      if ($(`opts-display-${v.idx}`)) $(`opts-display-${v.idx}`).innerHTML = v.mountOptsHtml;
      if ($(`alloc-display-${v.idx}`)) $(`alloc-display-${v.idx}`).innerHTML = this.renderAllocBars(v, true);
    }
  },

  /**
   * Renders the primary Master Dashboard grid of all detected BTRFS pools.
   */
  renderMaster() {
    this.renderOrphanBanner();
    const container = $("disk-container");
    if (!container) return;

    if (!this.vols.length) {
      container.innerHTML = "<p class='mt-15 text-muted'>No active BTRFS storage pools detected.</p>";
      return;
    }

    container.innerHTML = this.vols
      .map((v) => {
        const alertBadge = v.hasMissing
          ? '<span class="badge-danger">Degraded (Disk Missing)</span>'
          : v.totalDevErrors > 0
            ? '<span class="badge-meta-warn">⚠️ IO Errors</span>'
            : "";

        return `
        <div class="btrfs-card hoverable h-100-col">
          <div class="card-header-clean">
            <div>
              <h3 class="card-title-text">${escapeHtml(v.label)}</h3>
              ${alertBadge ? `<div class="mt-5">${alertBadge}</div>` : ""}
            </div>
            <div class="card-status-tag">
              ${
                v.mountPoint
                  ? `<span class="badge-mounted">${escapeHtml(v.mountPoint)}</span>`
                  : `<span class="badge-ro">Not Mounted</span>`
              }
            </div>
          </div>
          <div class="spec-table mt-15 mb-20">
            <div class="spec-row">
              <span class="spec-label">UUID</span>
              <span class="btrfs-code text-truncate" title="${escapeHtml(v.uuid)}">${escapeHtml(v.uuid)}</span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Hardware</span>
              <span class="spec-val text-muted">${escapeHtml(v.hwList)}</span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Capacity</span>
              <span class="spec-val"><b>${escapeHtml(v.rawSize)}</b> (Usable: <span id="master-usable-${v.idx}">${escapeHtml(v.usable)}</span>)</span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Protection</span>
              <span class="spec-val" id="master-raid-${v.idx}">${v.raid}</span>
            </div>
            <div class="spec-row">
              <span class="spec-label">Auto-Snapshot</span>
              <span class="spec-val"><span id="master-snap-${v.idx}">${escapeHtml(v.snapStatus)}</span>${
                !this.hasSnapper && (v.snapStatus === "Not Configured" || v.snapStatus === "Loading...")
                  ? ' <span class="badge-snapper-missing">No Snapper</span>'
                  : ""
              }</span>
            </div>
          </div>
          <div id="master-alloc-${v.idx}">${this.renderAllocBars(v, false)}</div>
          <button class="btn btn-secondary w-100 mt-auto btn-action" data-action="open-detail" data-index="${v.idx}">Manage Storage Pool</button>
        </div>`;
      })
      .join("");
  },

  /**
   * Renders the deep management view for a specific storage pool.
   */
  renderDetail(idx) {
    const container = $("detail-container");
    if (!container) return;

    const v = this.vols.find((vol) => vol.idx == idx);
    if (!v) return;

    container.setAttribute("data-active-index", idx);

    const devRows = v.devs
      .map((d) => {
        const errCount = (v.devErrors && v.devErrors[d.path]) || 0;
        const errBadge =
          errCount > 0
            ? `<span class="badge-danger">⚠️ ${errCount} IO Errors</span>`
            : `<span class="badge-healthy">Healthy</span>`;
        const missingBadge = d.missing ? `<span class="badge-danger">MISSING</span>` : "";
        const canRemove = v.devs && v.devs.length > 1;

        const removeBtn =
          v.mountPoint && canRemove
            ? d.missing
              ? `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-missing-dev" data-mount="${escapeHtml(v.mountPoint)}">Remove Missing</button>`
              : `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-dev" data-mount="${escapeHtml(v.mountPoint)}" data-devpath="${escapeHtml(d.path)}">Remove</button>`
            : "";

        return `<tr>
          <td><span class="btrfs-code ${d.missing ? "text-danger" : ""}">${escapeHtml(d.path)}</span></td>
          <td class="text-muted text-sm">${escapeHtml(d.id)}</td>
          <td class="text-sm fw-bold">${escapeHtml(d.size)}</td>
          <td>${missingBadge || errBadge}</td>
          <td class="text-right">${removeBtn}</td>
        </tr>`;
      })
      .join("");

    // Deterministic protection of operating system root disk
    const isRoot = v.mountPoint === "/" || v.devs.some((d) => this.rootDevs.has(d.path));
    const bSafe = boxId(v.mountPoint);

    container.innerHTML = `
      <div class="pool-detail-header mb-20">
        <div class="pool-title-group">
          <h2 class="pool-title">${escapeHtml(v.label)}</h2>
          <div class="tag-group mt-5">
            ${
              v.mountPoint
                ? `<span class="badge-mounted">Mounted: ${escapeHtml(v.mountPoint)}</span>`
                : `<span class="badge-ro">Not Mounted (Locked)</span>`
            }
            <span class="btrfs-code">${escapeHtml(v.uuid)}</span>
          </div>
        </div>
      </div>
      <div class="detail-layout-grid">
        <div class="detail-left-col">
          <div class="btrfs-card">
            <h4 class="section-title">Storage Pool Overview</h4>
            <div class="spec-table mb-15">
              <div class="spec-row"><span class="spec-label">Physical Hardware</span><span class="spec-val text-primary fw-bold">${escapeHtml(v.hwList)}</span></div>
              <div class="spec-row"><span class="spec-label">Total Drive Space</span><span class="spec-val">${escapeHtml(v.rawSize)}</span></div>
              <div class="spec-row"><span class="spec-label">Available Storage</span><span id="usable-display-${v.idx}" class="spec-val fw-bold">${escapeHtml(v.usable)}</span></div>
              <div class="spec-row"><span class="spec-label">Data Protection</span><span id="raid-display-${v.idx}" class="spec-val">${v.raid}</span></div>
              <div class="spec-row"><span class="spec-label">Automatic Backups</span><span id="snap-display-${v.idx}" class="spec-val fw-bold">${escapeHtml(v.snapStatus)}</span></div>
              <div class="spec-row"><span class="spec-label">Drive Health</span><span id="health-display-${v.idx}" class="spec-val">${v.healthHtml || '<span class="text-success fw-bold">✓ Healthy (No Errors)</span>'}</span></div>
              <div class="spec-row"><span class="spec-label">Active Features</span><span id="opts-display-${v.idx}" class="spec-val">${v.mountOptsHtml || '<span class="text-muted">Standard</span>'}</span></div>
            </div>
            <div id="alloc-display-${v.idx}">${this.renderAllocBars(v, true)}</div>
            <h5 class="sub-section-title mt-20 mb-10">Member Drives</h5>
            <div class="table-scroll-container mb-15">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Drive Path</th>
                    <th>Device ID</th>
                    <th>Capacity</th>
                    <th>Health</th>
                    <th class="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>${devRows}</tbody>
              </table>
            </div>
            ${
              v.mountPoint
                ? `<div class="advanced-topo-actions">
                    <button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${escapeHtml(v.mountPoint)}">Add Drive</button>
                    <button class="btn btn-secondary btn-sm btn-action" data-action="convert-data" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Change Data Protection</button>
                    <button class="btn btn-secondary btn-sm btn-action" data-action="convert-metadata" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Change Metadata Protection</button>
                  </div>`
                : ""
            }
          </div>
          ${
            v.mountPoint
              ? `<div class="btrfs-card">
                  <h4 class="section-title">Storage Optimization &amp; Health</h4>
                  <div class="toolbar-actions mb-15">
                    <button class="btn btn-primary btn-sm btn-action" id="btn-scrub-${bSafe}" data-action="scrub" data-mount="${escapeHtml(v.mountPoint)}">Verify &amp; Repair</button>
                    <button class="btn btn-secondary btn-sm btn-action" id="btn-balance-${bSafe}" data-action="balance" data-mount="${escapeHtml(v.mountPoint)}">Optimize Space</button>
                    <button class="btn btn-secondary btn-sm btn-action" id="btn-defrag-${bSafe}" data-action="defrag" data-mount="${escapeHtml(v.mountPoint)}">Defragment</button>
                    <button class="btn btn-secondary btn-sm btn-action" data-action="device-stats" data-mount="${escapeHtml(v.mountPoint)}">Drive Diagnostics</button>
                  </div>
                  <div class="terminal-window">
                    <div class="terminal-header">
                      <div class="terminal-title">Activity Log (${escapeHtml(v.mountPoint)})</div>
                      <div class="terminal-header-actions">
                        <span id="term-status-${bSafe}" class="term-status-badge">Idle</span>
                        <button class="term-clear-btn btn-action" data-action="clear-terminal" data-box="${bSafe}">Clear</button>
                      </div>
                    </div>
                    <div id="maint-console-${bSafe}" class="terminal-body"><span class="term-muted">Ready. Select an optimization or health task above.</span></div>
                  </div>
                </div>`
              : `<div class="warning-box"><p class="text-warning mb-5">Storage Pool Locked</p><p class="text-muted mb-0">Mount this storage pool via Cockpit <b>Storage</b> to unlock subvolume and maintenance tasks.</p></div>`
          }
          <div class="btrfs-card danger-card">
            <h4 class="section-title text-danger">Delete Storage Pool</h4>
            <p class="danger-desc">Permanently remove this storage pool. Unmounts member drives, cleans backup schedules, and wipes drive signatures.</p>
            ${
              isRoot
                ? `<div class="warning-box"><p class="text-warning mb-0"><b>Protected System Drive:</b> This pool contains the operating system root (<code>/</code>) and cannot be deleted.</p></div>`
                : `<button class="btn btn-danger btn-sm btn-action" data-action="destroy-vol-modal" data-mount="${escapeHtml(v.mountPoint || "")}" data-uuid="${escapeHtml(v.uuid)}" data-label="${escapeHtml(v.label)}" data-devs="${escapeHtml(v.devs.map((d) => d.path).join(" "))}" data-index="${v.idx}">Permanently Delete Pool</button>`
            }
          </div>
        </div>
        <div class="detail-right-col">
          <div class="btrfs-card mb-20">
            <div class="card-header-clean mb-15">
              <h4 class="section-title mb-0">Subvolumes (Folders)</h4>
            </div>
            ${
              v.mountPoint
                ? `<div class="create-bar mb-15">
                    <input type="text" id="new-subvol-${v.idx}" placeholder="Subvolume name or path (e.g. data or var/lib/machines)..." class="form-input flex-grow">
                    <button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Create Subvolume</button>
                  </div>
                  <div id="subvol-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading subvolumes...</p></div>`
                : '<p class="text-warning mb-0">Mount storage pool in Cockpit Storage to view and manage subvolumes.</p>'
            }
          </div>

          <div class="btrfs-card">
            <div class="card-header-clean mb-15">
              <h4 class="section-title mb-0">Snapshots (Backups)</h4>
              ${
                v.mountPoint
                  ? `<div class="toolbar-actions">
                      <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${escapeHtml(v.mountPoint)}">Take Snapshot</button>
                      <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="auto-snap" data-path="" data-mount="${escapeHtml(v.mountPoint)}">Auto-Backups</button>
                      <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="purge-snaps" data-mount="${escapeHtml(v.mountPoint)}">Clean Old</button>
                    </div>`
                  : ""
              }
            </div>
            ${
              v.mountPoint
                ? `<div id="snapshot-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading snapshots...</p></div>`
                : '<p class="text-warning mb-0">Mount storage pool in Cockpit Storage to view and manage snapshots.</p>'
            }
          </div>
        </div>
      </div>`;

    if (v.mountPoint) this.fetchSubvols(v.mountPoint, v.idx);
  },

  /**
   * Lists subvolumes and snapshots with optimized single-pass /etc/fstab parsing.
   */
  async fetchSubvols(mount, idx) {
    if (!$(`subvol-list-${idx}`) && !$(`snapshot-list-${idx}`)) return;

    try {
      const script = `
MNT="$1"
${Sh.mountTopLevel}

SCAN_DIR="$MNT"
[ "$IS_MOUNTED" -eq 1 ] && SCAN_DIR="$TMP"

SNAP_IDS=$(btrfs subvolume list -s "$SCAN_DIR" 2>/dev/null | awk '{print $2}')
RO_IDS=$(btrfs subvolume list -r "$SCAN_DIR" 2>/dev/null | awk '{print $2}')
DEFAULT_ID=$(btrfs subvolume get-default "$SCAN_DIR" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="ID") print $(i+1)}' | head -n 1)
ACTIVE_MOUNTS=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp")

# Optimized: Read /etc/fstab once into memory buffer
FSTAB_SUBVOLS=$(awk '!/^[[:space:]]*#/ && NF>=4 {
  n=split($4, o, ",");
  for(i=1;i<=n;i++) {
    if(match(o[i], /^subvol=(\\/?@?)(.*)/, m)) print m[2];
  }
}' /etc/fstab 2>/dev/null)

btrfs subvolume list "$SCAN_DIR" 2>/dev/null | while read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | awk '{print $2}')
  sub_path=$(echo "$line" | sed -n 's/.*path \\(.*\\)/\\1/p')
  [ -z "$id" ] && continue

  IS_SNAP="false"
  case "$sub_path" in
    .snapshots|@snapshots|*/.snapshots|*/@snapshots) IS_SNAP="false" ;;
    *)
      if echo " $SNAP_IDS " | grep -q " $id "; then
        IS_SNAP="true"
      elif echo "$sub_path" | grep -q -E "\\.snapshots/|/snapshot|_snap_|snap-"; then
        IS_SNAP="true"
      fi
      ;;
  esac

  IS_RO="false"
  echo " $RO_IDS " | grep -q " $id " && IS_RO="true"

  IS_DEF="false"
  [ -n "$DEFAULT_ID" ] && [ "$id" = "$DEFAULT_ID" ] && IS_DEF="true"

  resolve_subvol_path "$sub_path" || true

  # Fetch creation time
  ctime=$(btrfs subvolume show -r "$id" "$SCAN_DIR" 2>/dev/null | awk '/Creation time:/ {print $3, $4; exit}')
  if [ -z "$ctime" ] && [ -n "$TARGET_PATH" ]; then
    ctime=$(btrfs subvolume show "$TARGET_PATH" 2>/dev/null | awk '/Creation time:/ {print $3, $4; exit}')
  fi
  [ -z "$ctime" ] || [ "$ctime" = "-" ] && ctime="Active Subvolume"

  nocow="false"
  MOUNT_PT=""
  IN_FSTAB="false"

  if [ "$IS_SNAP" = "false" ]; then
    MOUNT_PT=$(echo "$ACTIVE_MOUNTS" | while read -r m_tgt m_src; do
      s_clean=$(echo "$m_src" | sed -n 's/.*\\[\\/*\\(.*\\)\\]/\\1/p')
      if [ -n "$s_clean" ] && [ "$s_clean" = "$sub_path" ]; then
        echo "$m_tgt"
        break
      fi
    done)
    [ -z "$TARGET_PATH" ] && [ -n "$MOUNT_PT" ] && TARGET_PATH="$MOUNT_PT"

    if [ -n "$TARGET_PATH" ]; then
      attr=$(lsattr -d "$TARGET_PATH" 2>/dev/null | awk '{print $1}')
      case "$attr" in *C*) nocow="true" ;; esac
    fi

    # Fast check against cached fstab buffer
    if [ -n "$FSTAB_SUBVOLS" ] && echo "$FSTAB_SUBVOLS" | grep -qxF "$sub_path"; then
      IN_FSTAB="true"
    fi
  fi

  echo "$id|$sub_path|$nocow|$ctime|$MOUNT_PT|$IN_FSTAB|$IS_SNAP|$IS_RO|$IS_DEF"
done
`;

      const out = await cmd(["sh", "-c", script, "--", mount]);
      let subvolsRows = "";
      let snapshotsRows = "";

      out
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .forEach((line) => {
          const parts = line.split("|");
          if (parts.length < 4) return;
          const [id, path, nocowStr, ctime, mountPt = "", inFstabStr, isSnapStr, isRoStr, isDefStr] = parts;

          const nocow = nocowStr === "true";
          const inFstab = inFstabStr === "true";
          const isRo = isRoStr === "true";
          const isDef = isDefStr === "true";

          const isSnapshotContainer =
            path === ".snapshots" ||
            path === "@snapshots" ||
            path.endsWith("/.snapshots") ||
            path.endsWith("/@snapshots");

          const isSnapshot = !isSnapshotContainer && isSnapStr === "true";
          const isRootSubvol =
            mountPt === "/" ||
            (mount === "/" && (path === "@" || path === "" || path === "root" || path === "rootfs" || path === "@root"));

          const isProtected = isSnapshotContainer || isRootSubvol || Boolean(mountPt) || inFstab;

          if (isSnapshot) {
            snapshotsRows += `<tr>
              <td><span class="btrfs-code">/${escapeHtml(path)}</span></td>
              <td class="text-muted text-sm">${escapeHtml(ctime)}</td>
              <td class="text-muted text-sm">${escapeHtml(id)}</td>
              <td>
                <div class="tag-group">
                  ${isRo ? '<span class="badge-ro">Read-Only</span>' : '<span class="badge-rw">Writable</span>'}
                </div>
              </td>
              <td class="text-right">
                <div class="btn-group-sharp">
                  <button class="btn-tool btn-action" title="Restore this snapshot into a new writable folder" data-action="subvol-ops" data-op="clone-snap" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Restore</button>
                  <button class="btn-tool btn-action" title="${isRo ? "Make writable" : "Protect as Read-Only"}" data-action="subvol-ops" data-op="toggle-ro" data-ro="${isRo ? "false" : "true"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                    ${isRo ? "Unlock" : "Lock"}
                  </button>
                  <button class="btn-tool btn-tool-danger btn-action" title="Delete snapshot" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Delete</button>
                </div>
              </td>
            </tr>`;
          } else {
            let badgeHtml = "";
            if (isSnapshotContainer) badgeHtml += '<span class="badge-fstab">Snapshot Storage</span>';
            else if (isRootSubvol) badgeHtml += '<span class="badge-root">OS Root (/)</span>';
            else if (mountPt) badgeHtml += `<span class="badge-mounted">${escapeHtml(mountPt)}</span>`;
            else if (inFstab) badgeHtml += '<span class="badge-fstab">In /etc/fstab</span>';

            if (isDef) badgeHtml += '<span class="badge-default-mount">Default</span>';
            if (isRo) badgeHtml += '<span class="badge-ro">RO</span>';
            if (nocow) badgeHtml += '<span class="badge-nocow">NoCOW</span>';

            const actionButtons = isSnapshotContainer
              ? '<span class="text-muted text-sm">Protected</span>'
              : `<div class="btn-group-sharp">
                  <button class="btn-tool btn-action" title="${nocow ? "Enable Copy-on-Write (+CoW)" : "Disable Copy-on-Write (NoCoW)"}" data-action="subvol-ops" data-op="${nocow ? "enable-cow" : "disable-cow"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                    ${nocow ? "+CoW" : "NoCoW"}
                  </button>
                  ${
                    !isProtected
                      ? `<button class="btn-tool btn-tool-danger btn-action" title="Delete subvolume" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}" data-mounted-at="${escapeHtml(mountPt)}" data-is-protected="${isProtected}">Delete</button>`
                      : ""
                  }
                </div>`;

            subvolsRows += `<tr>
              <td><span class="btrfs-code">/${escapeHtml(path)}</span></td>
              <td class="text-muted text-sm">${escapeHtml(ctime)}</td>
              <td class="text-muted text-sm">${escapeHtml(id)}</td>
              <td><div class="tag-group">${badgeHtml}</div></td>
              <td class="text-right">${actionButtons}</td>
            </tr>`;
          }
        });

      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML = subvolsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Subvolume Folder</th>
                  <th>Date Created</th>
                  <th>ID</th>
                  <th>Features</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>${subvolsRows}</tbody>
            </table>`
          : "<p class='p-15-muted'>No active user subvolumes found inside this pool root.</p>";
      }

      if ($(`snapshot-list-${idx}`)) {
        $(`snapshot-list-${idx}`).innerHTML = snapshotsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Snapshot Backup</th>
                  <th>Date Created</th>
                  <th>ID</th>
                  <th>Access</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>${snapshotsRows}</tbody>
            </table>`
          : "<p class='p-15-muted'>No snapshots created yet for this volume.</p>";
      }
    } catch (err) {
      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML = `<p class='text-danger mt-15'>Load failed: ${escapeHtml(err.message)}</p>`;
      }
    }
  },
};

