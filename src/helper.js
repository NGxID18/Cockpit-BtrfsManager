window.$ = (id) => document.getElementById(id);
window.on = (id, evt, cb) => $(id)?.addEventListener(evt, cb);

window.boxId = (mnt) => (!mnt || mnt === "/" ? "root" : mnt.replace(/[^a-zA-Z0-9]/g, "-"));

window.cmd = (args, opts = {}) =>
  cockpit.spawn(args, {
    superuser: "require",
    environ: ["LC_ALL=C.UTF-8", "LANG=C.UTF-8"],
    ...opts,
  });

window.escapeHtml = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

window.parseSize = (val) => {
  if (!val) return 0;
  const match = String(val).match(/([0-9.]+)\s*([KMGTPE]?)/i);
  if (!match) return 0;
  const unitExponents = { K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const exp = unitExponents[match[2].toUpperCase()] || 0;
  return parseFloat(match[1]) * Math.pow(1024, exp);
};

window.formatSize = (bytes) => {
  if (!bytes || isNaN(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return i <= 0 ? `${Math.round(bytes)} B` : `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
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
     mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null || \\
     mount -t btrfs -o subvolid=5,ro "$DEV" "$TMP" 2>/dev/null; then
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
  elif [ "$MNT" = "/" ] && [ -e "/$_sp" ]; then
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
         { [ -n "$_cfg" ] && [ "$_cfg" != "Config" ] && [ "$_cfg" != "root" ] && { [ "$(basename "$_cf")" = "btrfs_snap_$_cfg" ] || grep -qxF "# Config: $_cfg" "$_cf" 2>/dev/null; }; }; then
        rm -f "$_cf" 2>/dev/null || true
      fi
    done
  done
}

purge_snapper_cfg() {
  _cfg="$1"
  [ -z "$_cfg" ] || [ "$_cfg" = "Config" ] || [ "$_cfg" = "root" ] && return 0
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

window.Dropdown = {
  parseLabel(rawText) {
    let text = String(rawText || "").trim();
    let isCurrent = false;
    if (text.endsWith("[Current]")) {
      isCurrent = true;
      text = text.slice(0, -"[Current]".length).trim();
    }

    let depth = 0;
    let splitIdx = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && depth > 0) depth--;
      else if (depth === 0 && text.startsWith(" - ", i)) {
        splitIdx = i;
        break;
      }
    }

    if (splitIdx !== -1) {
      return {
        title: text.slice(0, splitIdx).trim(),
        desc: text.slice(splitIdx + 3).trim(),
        isCurrent,
      };
    }

    const parenMatch = text.match(/^([^(]+?)\s*\((.+)\)$/);
    if (parenMatch) {
      return {
        title: parenMatch[1].trim(),
        desc: parenMatch[2].trim(),
        isCurrent,
      };
    }

    return { title: text, desc: "", isCurrent };
  },

  enhance(selectEl) {
    if (!selectEl) return null;
    if (selectEl._pfWrapper) {
      this.refresh(selectEl);
      return selectEl._pfWrapper;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "pf-select";
    if (selectEl.classList.contains("w-100")) wrapper.classList.add("pf-select-full");
    if (selectEl.classList.contains("hidden-element")) wrapper.classList.add("hidden-element");

    selectEl.classList.add("pf-select-native");
    selectEl.tabIndex = -1;
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "pf-select-toggle";
    toggleBtn.setAttribute("aria-haspopup", "listbox");
    toggleBtn.setAttribute("aria-expanded", "false");
    toggleBtn.innerHTML =
      '<span class="pf-select-toggle-content"></span><span class="pf-select-arrow" aria-hidden="true"></span>';

    const menu = document.createElement("div");
    menu.className = "pf-select-menu hidden-element";
    menu.setAttribute("role", "listbox");

    wrapper.appendChild(toggleBtn);
    wrapper.appendChild(menu);

    selectEl._pfWrapper = wrapper;
    selectEl._pfToggle = toggleBtn;
    selectEl._pfMenu = menu;

    const setMenuOpen = (open) => {
      wrapper.classList.toggle("pf-select-open", open);
      menu.classList.toggle("hidden-element", !open);
      toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toggleBtn.disabled) return;
      const willOpen = !wrapper.classList.contains("pf-select-open");
      this.closeAll(wrapper);
      setMenuOpen(willOpen);
      if (willOpen) {
        const selected = menu.querySelector(".pf-select-option-selected:not(:disabled)");
        selected?.scrollIntoView({ block: "nearest" });
      }
    });

    const moveFocus = (delta) => {
      const enabledOpts = Array.from(menu.querySelectorAll(".pf-select-option:not(:disabled)"));
      if (!enabledOpts.length) return;
      const activeIdx = enabledOpts.indexOf(document.activeElement);
      let nextIdx;
      if (activeIdx === -1) {
        const curIdx = enabledOpts.findIndex((btn) => btn.classList.contains("pf-select-option-selected"));
        nextIdx = curIdx !== -1 ? (curIdx + delta + enabledOpts.length) % enabledOpts.length : 0;
      } else {
        nextIdx = (activeIdx + delta + enabledOpts.length) % enabledOpts.length;
      }
      enabledOpts[nextIdx].focus();
    };

    toggleBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!wrapper.classList.contains("pf-select-open")) {
          this.closeAll(wrapper);
          setMenuOpen(true);
        }
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
      }
    });

    menu.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Tab") {
        setMenuOpen(false);
      }
    });

    selectEl.addEventListener("change", () => this.refresh(selectEl));

    const observer = new MutationObserver(() => this.refresh(selectEl));
    observer.observe(selectEl, {
      childList: true,
      attributes: true,
      attributeFilter: ["class", "disabled"],
    });

    this.refresh(selectEl);
    return wrapper;
  },

  refresh(selectOrId) {
    const selectEl = typeof selectOrId === "string" ? $(selectOrId) : selectOrId;
    if (!selectEl) return;
    if (!selectEl._pfWrapper) {
      this.enhance(selectEl);
      return;
    }

    const wrapper = selectEl._pfWrapper;
    const toggleBtn = selectEl._pfToggle;
    const toggleContent = toggleBtn.querySelector(".pf-select-toggle-content");
    const menu = selectEl._pfMenu;

    wrapper.classList.toggle("hidden-element", selectEl.classList.contains("hidden-element"));
    wrapper.classList.toggle("pf-select-full", selectEl.classList.contains("w-100"));

    const opts = Array.from(selectEl.options);
    const isEmptyOnly = opts.length === 0 || (opts.length === 1 && opts[0].value === "");
    toggleBtn.disabled = Boolean(selectEl.disabled || isEmptyOnly);

    if (selectEl.selectedIndex < 0 && opts.length > 0) {
      selectEl.selectedIndex = 0;
    }

    const selectedOpt = opts[selectEl.selectedIndex] || opts[0];
    if (selectedOpt) {
      const parsed = this.parseLabel(selectedOpt.textContent);
      toggleContent.innerHTML =
        `<span class="pf-select-toggle-title">${escapeHtml(parsed.title)}</span>` +
        (parsed.desc ? `<span class="pf-select-toggle-desc">— ${escapeHtml(parsed.desc)}</span>` : "") +
        (parsed.isCurrent ? `<span class="pf-select-badge">Current</span>` : "");
    } else {
      toggleContent.innerHTML = '<span class="pf-select-toggle-desc">Select an option...</span>';
    }

    menu.innerHTML = opts
      .map((opt) => {
        const isSelected = opt.selected;
        const isDisabled = Boolean(opt.disabled || (opt.value === "" && opts.length === 1));
        const p = this.parseLabel(opt.textContent);
        return `
          <button type="button" class="pf-select-option${isSelected ? " pf-select-option-selected" : ""}${isDisabled ? " pf-select-option-disabled" : ""}" role="option" aria-selected="${isSelected}" data-value="${escapeHtml(opt.value)}" ${isDisabled ? "disabled" : ""}>
            <span class="pf-select-opt-header">
              <span class="pf-select-opt-title">${escapeHtml(p.title)}</span>
              ${p.isCurrent ? `<span class="pf-select-badge">Current</span>` : ""}
            </span>
            ${p.desc ? `<span class="pf-select-opt-desc">${escapeHtml(p.desc)}</span>` : ""}
          </button>`;
      })
      .join("");

    menu.querySelectorAll(".pf-select-option:not(:disabled)").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectEl.value = btn.getAttribute("data-value");
        this.closeAll();
        this.refresh(selectEl);
        toggleBtn.focus();
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  },

  closeAll(exceptWrapper = null) {
    document.querySelectorAll(".pf-select.pf-select-open").forEach((wrapper) => {
      if (wrapper === exceptWrapper) return;
      wrapper.classList.remove("pf-select-open");
      wrapper.querySelector(".pf-select-menu")?.classList.add("hidden-element");
      wrapper.querySelector(".pf-select-toggle")?.setAttribute("aria-expanded", "false");
    });
  },

  initAll() {
    document.querySelectorAll("select.form-input").forEach((sel) => this.enhance(sel));
  },
};

document.addEventListener("click", (e) => {
  if (!e.target.closest(".pf-select")) Dropdown.closeAll();
});

window.Modal = {
  callback: null,

  show(title, message, type = "alert", options = null, callback = null, btnText = null, isDanger = false) {
    const modal = $("generic-modal");
    if (!modal) return;

    Dropdown.closeAll();
    $("generic-modal-title").innerText = title;
    $("generic-modal-message").innerText = message;

    const inputContainer = $("generic-modal-input-container");
    const inputEl = $("generic-modal-input");
    const selectEl = $("generic-modal-select");
    const cancelBtn = $("generic-modal-cancel");
    const confirmBtn = $("generic-modal-confirm");

    inputContainer?.classList.toggle("hidden-element", type === "alert" || type === "confirm");
    inputEl?.classList.toggle("hidden-element", type !== "prompt");
    selectEl?.classList.toggle("hidden-element", type !== "select");
    cancelBtn?.classList.toggle("hidden-element", type === "alert");

    if (confirmBtn) {
      confirmBtn.innerText = btnText || (type === "alert" ? "OK" : "Confirm");
      confirmBtn.classList.toggle("btn-danger", Boolean(isDanger));
      confirmBtn.classList.toggle("btn-primary", !isDanger);
    }

    if (type === "prompt" && inputEl) {
      inputEl.value = options || "";
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 80);
    } else if (type === "select" && selectEl) {
      selectEl.innerHTML = (options || [])
        .map((opt) => `<option value="${escapeHtml(opt.v)}">${escapeHtml(opt.l)}</option>`)
        .join("");
      Dropdown.refresh(selectEl);
      setTimeout(() => selectEl._pfToggle?.focus(), 80);
    }

    this.callback = callback;
    modal.classList.remove("hidden-element");
  },

  close() {
    Dropdown.closeAll();
    $("generic-modal")?.classList.add("hidden-element");
    this.callback = null;
  },

  confirm() {
    const actionCallback = this.callback;
    const selectEl = $("generic-modal-select");
    const inputEl = $("generic-modal-input");

    const value =
      selectEl && !selectEl.classList.contains("hidden-element")
        ? selectEl.value
        : inputEl
          ? inputEl.value
          : "";

    this.close();
    if (actionCallback) actionCallback(value);
  },
};

window.customAlert = (title, message) =>
  Modal.show(title, message, "alert", null, null, "OK", false);

window.customConfirm = (title, message, confirmBtnText, onConfirm, isDanger = false) =>
  Modal.show(title, message, "confirm", null, onConfirm, confirmBtnText || "Confirm", isDanger);

window.customPrompt = (title, message, defaultValue, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "prompt", defaultValue, onConfirm, confirmBtnText || "Submit", false);

window.customSelect = (title, message, options, confirmBtnText, onConfirm) =>
  Modal.show(title, message, "select", options, onConfirm, confirmBtnText || "Select", false);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.querySelector(".pf-select.pf-select-open")) {
      Dropdown.closeAll();
      return;
    }
    ["generic-modal", "add-dev-modal", "destroy-vol-modal"].forEach((id) =>
      $(id)?.classList.add("hidden-element"),
    );
    Modal.callback = null;
  } else if (
    e.key === "Enter" &&
    !$("generic-modal")?.classList.contains("hidden-element") &&
    document.activeElement === $("generic-modal-input")
  ) {
    e.preventDefault();
    Modal.confirm();
  }
});
