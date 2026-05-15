import fs from "node:fs/promises";
import path from "node:path";

const INSIGHT_PATCH = String.raw`
<script data-smart-note-insight-patch>
(function () {
  function findInsightNav() {
    return Array.from(document.querySelectorAll("nav > *"))
      .find((element) => element.textContent && element.textContent.includes("灵感"));
  }

  function elements() {
    const modal = document.getElementById("add-modal");
    const urlInput = document.getElementById("url-input");
    const manualInput = document.getElementById("manual-text-input");
    const manualPanel = document.getElementById("manual-input-panel");
    const title = modal && modal.querySelector("h2");
    const subtitle = title && title.nextElementSibling;
    const urlPanel = urlInput && urlInput.closest(".bg-gray-50");
    const manualLabels = manualPanel ? manualPanel.querySelectorAll("span") : [];
    const submit = document.getElementById("submit-btn");
    return { modal, urlInput, manualInput, manualPanel, title, subtitle, urlPanel, manualLabels, submit };
  }

  function setInsightMode(enabled) {
    const ui = elements();
    if (!ui.modal || !ui.submit) return;
    ui.modal.dataset.mode = enabled ? "insight" : "link";
    if (ui.title) ui.title.textContent = enabled ? "记录灵感" : "添加新内容";
    if (ui.subtitle) ui.subtitle.textContent = enabled ? "写下想法、摘录或待整理笔记" : "支持公众号、小红书或视频链接";
    if (ui.urlPanel) ui.urlPanel.classList.toggle("hidden", enabled);
    if (ui.manualPanel) ui.manualPanel.classList.toggle("hidden", !enabled);
    if (ui.manualLabels[0]) ui.manualLabels[0].textContent = enabled ? "灵感正文" : "正文/摘录";
    if (ui.manualLabels[1]) ui.manualLabels[1].textContent = enabled ? "保存到灵感" : "公众号、小红书读不到时填写";
    if (ui.manualInput) {
      ui.manualInput.placeholder = enabled
        ? "写下当前想法、摘录、待办或稍后要整理的内容..."
        : "粘贴文章正文、分享文案或你想保留的重点摘录...";
    }
    const span = ui.submit.querySelector("span");
    const icon = ui.submit.querySelector("i");
    if (span) span.textContent = enabled ? "保存灵感" : "开始智能提取";
    if (icon) icon.className = enabled ? "fa-solid fa-wand-sparkles" : "fa-solid fa-bolt-lightning";
  }

  window.openInsightModal = function openInsightModal() {
    if (typeof window.openAddModal === "function") window.openAddModal();
    setInsightMode(true);
    setTimeout(function () {
      const input = document.getElementById("manual-text-input");
      if (input) input.focus();
    }, 80);
  };

  const originalClose = window.closeAddModal;
  if (typeof originalClose === "function") {
    window.closeAddModal = function patchedCloseAddModal() {
      originalClose();
      setInsightMode(false);
    };
  }

  async function submitInsight(event) {
    const ui = elements();
    if (!ui.modal || ui.modal.dataset.mode !== "insight") return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const text = (ui.manualInput && ui.manualInput.value || "").trim();
    if (!text) {
      if (typeof window.setStatus === "function") window.setStatus("请先写下灵感内容", true);
      return;
    }

    if (typeof window.setSubmitBusy === "function") window.setSubmitBusy(true);
    const busySpan = ui.submit && ui.submit.querySelector("span");
    if (busySpan) busySpan.textContent = "保存中...";
    if (typeof window.setStatus === "function") window.setStatus("正在保存灵感...");

    try {
      const payload = await window.api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ body: text, favorite: false, category: "灵感" })
      });
      const note = payload.item;
      if (typeof window.loadNotes === "function") await window.loadNotes();
      if (typeof window.closeAddModal === "function") window.closeAddModal();
      if (note && typeof window.openDetail === "function" && typeof window.viewModel === "function") {
        window.openDetail(window.viewModel(note));
      }
    } catch (error) {
      if (typeof window.setStatus === "function") {
        window.setStatus(error && error.message ? error.message : "保存失败，请稍后再试", true);
      }
    } finally {
      if (typeof window.setSubmitBusy === "function") window.setSubmitBusy(false);
    }
  }

  function bind() {
    const insightNav = findInsightNav();
    if (insightNav) {
      insightNav.onclick = window.openInsightModal;
      insightNav.classList.add("cursor-pointer", "active:scale-95", "transition-all");
      insightNav.setAttribute("role", "button");
      insightNav.setAttribute("aria-label", "写灵感");
    }

    const submit = document.getElementById("submit-btn");
    if (submit && !submit.dataset.insightBound) {
      submit.dataset.insightBound = "true";
      submit.addEventListener("click", submitInsight, true);
    }

    const manualInput = document.getElementById("manual-text-input");
    if (manualInput && !manualInput.dataset.insightKeyBound) {
      manualInput.dataset.insightKeyBound = "true";
      manualInput.addEventListener("keydown", function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitInsight(event);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
</script>`;

export default async function handler(req, res) {
  const indexPath = path.join(process.cwd(), "public", "index.html");
  let html = await fs.readFile(indexPath, "utf8");
  if (!html.includes("data-smart-note-insight-patch")) {
    html = html.replace("</body>", `${INSIGHT_PATCH}\n</body>`);
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}
