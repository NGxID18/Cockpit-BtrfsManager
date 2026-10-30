window.$ = (id) => document.getElementById(id);
window.on = (id, evt, cb) => $(id)?.addEventListener(evt, cb);
window.boxId = (mnt) => (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");

window.cmd = (args, opts = {}) =>
  cockpit.spawn(args, {
    superuser: "require",
    environ: ["LC_ALL=C.UTF-8", "LANG=C.UTF-8"],
    ...opts,
  });

window.escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

window.parseSize = (s) => {
  if (!s) return 0;
  const m = String(s).match(/([0-9.]+)\s*([KMGTPE]?)/i);
  if (!m) return 0;
  const exp = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 }[m[2].toUpperCase()] || 0;
  return parseFloat(m[1]) * Math.pow(1024, exp);
};

window.formatSize = (b) => {
  if (!b || isNaN(b) || b <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  return i <= 0 ? `${Math.round(b)} B` : `${(b / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

window.Sh = {
  mountTopLevel: `
DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df -P "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
case "$DEV" in
  UUID=*|LABEL=*) DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1) ;;
esac
TMP=$(mktemp -d)
IS_MOUNTED=0
cleanup_tmp() {
  if [ "\${IS_MOUNTED:-0}" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
  fi
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup_tmp EXIT
if [ -n "$DEV" ]; then
  if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null || \\
     mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
    IS_MOUNTED=1
  fi
fi
resolve_subvol_path() {
  _sp="$1"
  TARGET_PATH=""
  if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$_sp" ]; then
    TARGET_PATH="$TMP/$_sp"
  elif [ -e "$MNT/$_sp" ]; then
    TARGET_PATH="$MNT/$_sp"
  elif [ -e "/$_sp" ]; then
    TARGET_PATH="/$_sp"
  fi
  [ -n "$TARGET_PATH" ]
}
in_fstab() {
  awk -v sp="$1" '!/^[[:space:]]*#/ && NF>=4 {
    n=split($4, o, ",");
    for(i=1;i<=n;i++) if(o[i]=="subvol="sp || o[i]=="subvol=/"sp || o[i]=="subvol=@"sp || o[i]=="subvol=/@"sp) {f=1; exit}
  } END {exit !f}' /etc/fstab 2>/dev/null
}
`,
  cleanSnapperFn: `
clean_target_cron() {
  _tgt="$1"
  _cfg="$2"
  for _cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
    [ -d "$_cdir" ] || continue
    for _cf in "$_cdir"/btrfs_*; do
      [ -f "$_cf" ] || continue
      if { [ -n "$_tgt" ] && grep -qxF "# Target: $_tgt" "$_cf" 2>/dev/null; } || \\
         { [ -n "$_cfg" ] && [ "$_cfg" != "Config" ] && { [ "$(basename "$_cf")" = "btrfs_snap_$_cfg" ] || grep -qxF "# Config: $_cfg" "$_cf" 2>/dev/null; }; }; then
        rm -f "$_cf" 2>/dev/null || true
      fi
    done
  done
}
purge_snapper_cfg() {
  _cfg="$1"
  [ -z "$_cfg" ] || [ "$_cfg" = "Config" ] && return 0
  if command -v snapper >/dev/null 2>&1; then
    snapper -c "$_cfg" delete-config 2>/dev/null || true
  fi
  rm -f "/etc/snapper/configs/$_cfg" 2>/dev/null || true
  clean_target_cron "" "$_cfg"
  for _f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
    if [ -f "$_f" ]; then
      sed -i -E "/^SNAPPER_CONFIGS=/ { s/\\b$_cfg\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g; }" "$_f" 2>/dev/null || true
    fi
  done
}
`,
};

window.Modal = {
  cb: null,
  show(title, msg, type = "alert", opts = null, cb = null, btnText = null, isDanger = false) {
    const modal = $("generic-modal");
    if (!modal) return;
    $("generic-modal-title").innerText = title;
    $("generic-modal-message").innerText = msg;

    $("generic-modal-input-container")?.classList.toggle(
      "hidden-element",
      type === "alert" || type === "confirm",
    );

    const inputEl = $("generic-modal-input");
    inputEl?.classList.toggle("hidden-element", type !== "prompt");

    const selectEl = $("generic-modal-select");
    selectEl?.classList.toggle("hidden-element", type !== "select");

    $("generic-modal-cancel")?.classList.toggle("hidden-element", type === "alert");

    const confirmBtn = $("generic-modal-confirm");
    if (confirmBtn) {
      confirmBtn.innerText = btnText || (type === "alert" ? "OK" : "Confirm");
      confirmBtn.classList.toggle("btn-danger", Boolean(isDanger));
      confirmBtn.classList.toggle("btn-primary", !isDanger);
    }

    if (type === "prompt" && inputEl) {
      inputEl.value = opts || "";
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 80);
    } else if (type === "select" && selectEl) {
      selectEl.innerHTML = (opts || [])
        .map((o) => `<option value="${escapeHtml(o.v)}">${escapeHtml(o.l)}</option>`)
        .join("");
      setTimeout(() => selectEl.focus(), 80);
    }

    this.cb = cb;
    modal.classList.remove("hidden-element");
  },
  close() {
    $("generic-modal")?.classList.add("hidden-element");
    this.cb = null;
  },
  confirm() {
    const actionCallback = this.cb;
    const selectEl = $("generic-modal-select");
    const inputEl = $("generic-modal-input");
    const val =
      selectEl && !selectEl.classList.contains("hidden-element")
        ? selectEl.value
        : inputEl
          ? inputEl.value
          : "";
    this.close();
    if (actionCallback) actionCallback(val);
  },
};

window.customAlert = (title, message) =>
  Modal.show(title, message, "alert", null, null, "OK", false);

window.customConfirm = (title, message, confirmBtnText, onConfirm, isDanger = false) =>
  Modal.show(title, message, "confirm", null, onConfirm, confirmBtnText || "Confirm", isDanger);

window.customPrompt = (title, message, defaultVal, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "prompt", defaultVal, onConfirm, confirmBtnText || "Submit", false);

window.customSelect = (title, message, options, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "select", options, onConfirm, confirmBtnText || "Select", false);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    ["generic-modal", "add-dev-modal", "destroy-vol-modal"].forEach((id) =>
      $(id)?.classList.add("hidden-element"),
    );
    Modal.cb = null;
  } else if (
    e.key === "Enter" &&
    !$("generic-modal")?.classList.contains("hidden-element") &&
    document.activeElement === $("generic-modal-input")
  ) {
    e.preventDefault();
    Modal.confirm();
  }
});
