import fs from "node:fs/promises";
import path from "node:path";

const INSIGHT_PATCH = String.raw`
<script data-smart-note-insight-patch>
(function () {
  function findInsightNav() {
    return Array.from(document.querySelectorAll("nav > *"))
      .find((element) => element.textContent && element.textContent.includes("灵感"));
  }

  function isDoubaoUrl(url) {
    try {
      return new URL(url).hostname.includes("doubao");
    } catch {
      return false;
    }
  }

  function ensureDoubaoTab() {
    const tabBar = document.querySelector(".tab-btn") && document.querySelector(".tab-btn").parentElement;
    if (!tabBar || document.querySelector('[data-tab="doubao"]')) return;
    const button = document.createElement("button");
    button.dataset.tab = "doubao";
    button.className = "tab-btn px-5 py-2 bg-gray-100 text-gray-500 rounded-2xl text-xs font-bold";
    button.textContent = "豆包";
    button.onclick = function (event) {
      if (typeof window.filterCategory === "function") window.filterCategory("doubao", event);
    };
    tabBar.appendChild(button);
  }

  function elements() {
    const modal = document.getElementById("add-modal");
    const urlInput = document.getElementById("url-input");
    const manualInput = document.getElementById("manual-text-input");
    const manualPanel = document.getElementById("manual-input-panel");
    const expandButton = ensureExpandButton(manualPanel);
    const imageTools = ensureImageTools(manualPanel);
    const imageInput = document.getElementById("insight-image-input");
    const imageButton = document.getElementById("image-insight-btn");
    const imagePreview = document.getElementById("insight-image-preview");
    const title = modal && modal.querySelector("h2");
    const subtitle = title && title.nextElementSibling;
    const urlPanel = urlInput && urlInput.closest(".bg-gray-50");
    const manualLabels = manualPanel ? manualPanel.querySelectorAll("span") : [];
    const submit = document.getElementById("submit-btn");
    return { modal, urlInput, manualInput, manualPanel, title, subtitle, urlPanel, manualLabels, submit, expandButton, imageTools, imageInput, imageButton, imagePreview };
  }

  function ensureExpandButton(manualPanel) {
    let button = document.getElementById("ai-expand-btn");
    if (button || !manualPanel) return button;
    button = document.createElement("button");
    button.id = "ai-expand-btn";
    button.type = "button";
    button.className = "hidden mt-3 w-full bg-gray-900 text-white py-3 rounded-2xl font-black text-sm shadow-lg shadow-gray-100 active:scale-95 transition-all items-center justify-center gap-2";
    button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>AI 扩写</span>';
    manualPanel.appendChild(button);
    return button;
  }

  function ensureImageTools(manualPanel) {
    let tools = document.getElementById("insight-image-tools");
    if (tools || !manualPanel) return tools;
    tools = document.createElement("div");
    tools.id = "insight-image-tools";
    tools.className = "hidden mt-3";
    tools.innerHTML = '<input id="insight-image-input" type="file" accept="image/png,image/jpeg,image/webp" class="hidden"><button id="image-insight-btn" type="button" class="w-full bg-white text-blue-500 border border-blue-100 py-3 rounded-2xl font-black text-sm shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"><i class="fa-regular fa-image"></i><span>上传图片解析</span></button><div id="insight-image-preview" class="hidden mt-3 rounded-3xl border border-blue-100 bg-white p-3"></div>';
    manualPanel.appendChild(tools);
    return tools;
  }

  function setInsightMode(enabled) {
    const ui = elements();
    if (!ui.modal || !ui.submit) return;
    ui.modal.dataset.mode = enabled ? "insight" : "link";
    if (ui.title) ui.title.textContent = enabled ? "记录灵感" : "添加新内容";
    if (ui.subtitle) ui.subtitle.textContent = enabled ? "写下想法、摘录或待整理笔记" : "支持公众号、小红书或视频链接";
    if (ui.urlPanel) ui.urlPanel.classList.toggle("hidden", enabled);
    if (ui.manualPanel) ui.manualPanel.classList.toggle("hidden", !enabled);
    if (ui.expandButton) ui.expandButton.classList.toggle("hidden", !enabled);
    if (ui.expandButton) ui.expandButton.classList.toggle("flex", enabled);
    if (ui.imageTools) ui.imageTools.classList.toggle("hidden", !enabled);
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
      resetImagePreview();
      setInsightMode(false);
    };
  }

  function setExpandBusy(button, isBusy) {
    if (!button) return;
    button.disabled = isBusy;
    button.innerHTML = isBusy
      ? '<i class="fa-solid fa-circle-notch animate-spin"></i><span>GPT-5.5 扩写中...</span>'
      : '<i class="fa-solid fa-wand-magic-sparkles"></i><span>AI 扩写</span>';
    button.classList.toggle("opacity-70", isBusy);
  }

  async function expandInsight(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const ui = elements();
    const text = (ui.manualInput && ui.manualInput.value || "").trim();
    if (!text) {
      if (typeof window.setStatus === "function") window.setStatus("请先写下一点灵感，再让 AI 扩写", true);
      if (ui.manualInput) ui.manualInput.focus();
      return;
    }
    setExpandBusy(ui.expandButton, true);
    if (typeof window.setStatus === "function") window.setStatus("正在用 GPT-5.5 扩写灵感...");
    try {
      const payload = await window.api("/api/expand", {
        method: "POST",
        body: JSON.stringify({ text: text, mode: "insight" })
      });
      if (payload && payload.expandedText && ui.manualInput) ui.manualInput.value = payload.expandedText;
      if (typeof window.setStatus === "function") window.setStatus("AI 扩写完成，可以继续修改后保存");
      if (ui.manualInput) ui.manualInput.focus();
    } catch (error) {
      if (typeof window.setStatus === "function") {
        window.setStatus(error && error.message ? error.message : "AI 扩写失败，请稍后再试", true);
      }
    } finally {
      setExpandBusy(ui.expandButton, false);
    }
  }

  window.expandInsight = expandInsight;

  function setImageBusy(button, isBusy) {
    if (!button) return;
    button.disabled = isBusy;
    button.innerHTML = isBusy
      ? '<i class="fa-solid fa-circle-notch animate-spin"></i><span>图片解析中...</span>'
      : '<i class="fa-regular fa-image"></i><span>上传图片解析</span>';
    button.classList.toggle("opacity-70", isBusy);
  }

  function resetImagePreview() {
    const ui = elements();
    if (ui.imageInput) ui.imageInput.value = "";
    if (ui.imagePreview) {
      ui.imagePreview.classList.add("hidden");
      ui.imagePreview.innerHTML = "";
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.onerror = function () { reject(new Error("图片读取失败，请重新选择")); };
      reader.readAsDataURL(file);
    });
  }

  async function analyzeInsightImage(file) {
    const ui = elements();
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type || "")) {
      if (typeof window.setStatus === "function") window.setStatus("请上传 PNG、JPG 或 WebP 图片", true);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      if (typeof window.setStatus === "function") window.setStatus("图片过大，请选择 4MB 以内的图片", true);
      return;
    }
    setImageBusy(ui.imageButton, true);
    if (typeof window.setStatus === "function") window.setStatus("正在读取图片内容...");
    try {
      const imageDataUrl = await readFileAsDataUrl(file);
      if (ui.imagePreview) {
        ui.imagePreview.classList.remove("hidden");
        ui.imagePreview.innerHTML = '<div class="flex items-center gap-3"><img src="' + imageDataUrl + '" alt="待解析图片" class="w-16 h-16 rounded-2xl object-cover border border-blue-50"><div class="min-w-0"><div class="text-xs font-black text-gray-700 truncate">' + htmlEscape(file.name || "图片") + '</div><div data-image-preview-status class="text-[10px] font-bold text-gray-400 mt-1">AI 正在转写图片内容</div></div></div>';
      }
      const payload = await window.api("/api/image-insight", {
        method: "POST",
        body: JSON.stringify({ imageDataUrl: imageDataUrl, filename: file.name, mode: "insight" })
      });
      const extracted = payload && payload.extractedText || "";
      if (ui.manualInput) ui.manualInput.value = ui.manualInput.value.trim() ? ui.manualInput.value.trim() + "\n\n" + extracted : extracted;
      const previewStatus = ui.imagePreview && ui.imagePreview.querySelector("[data-image-preview-status]");
      if (previewStatus) previewStatus.textContent = "已用 " + (payload.model || "AI") + " 解析，可继续编辑";
      if (typeof window.setStatus === "function") window.setStatus("图片内容已写入灵感正文，可以继续修改后保存");
      if (ui.manualInput) ui.manualInput.focus();
    } catch (error) {
      if (typeof window.setStatus === "function") window.setStatus(error && error.message ? error.message : "图片解析失败，请稍后再试", true);
    } finally {
      setImageBusy(ui.imageButton, false);
    }
  }

  window.chooseInsightImage = function chooseInsightImage() {
    const ui = elements();
    if (ui.imageInput) ui.imageInput.click();
  };

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
    ensureDoubaoTab();
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

    const expandButton = ensureExpandButton(document.getElementById("manual-input-panel"));
    if (expandButton && !expandButton.dataset.expandBound) {
      expandButton.dataset.expandBound = "true";
      expandButton.addEventListener("click", expandInsight);
    }

    const imageTools = ensureImageTools(document.getElementById("manual-input-panel"));
    const imageButton = document.getElementById("image-insight-btn");
    const imageInput = document.getElementById("insight-image-input");
    if (imageTools && imageButton && !imageButton.dataset.imageBound) {
      imageButton.dataset.imageBound = "true";
      imageButton.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (imageInput) imageInput.click();
      });
    }
    if (imageInput && !imageInput.dataset.imageBound) {
      imageInput.dataset.imageBound = "true";
      imageInput.addEventListener("change", function (event) {
        analyzeInsightImage(event.target.files && event.target.files[0]);
      });
    }

    const manualInput = document.getElementById("manual-text-input");
    if (manualInput && !manualInput.dataset.insightKeyBound) {
      manualInput.dataset.insightKeyBound = "true";
      manualInput.addEventListener("keydown", function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitInsight(event);
      });
    }
  }

  function normalizePickText(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function localPickKey(id) {
    return "smart-note-picks:" + id;
  }

  function readLocalPicks(id) {
    try {
      return JSON.parse(localStorage.getItem(localPickKey(id)) || "[]").map(normalizePickText).filter(Boolean);
    } catch {
      return [];
    }
  }

  function writeLocalPicks(id, picks) {
    localStorage.setItem(localPickKey(id), JSON.stringify([...new Set(picks.map(normalizePickText).filter(Boolean))]));
  }

  function imageUrlsFromText(text) {
    const source = String(text || "").replace(/&amp;/g, "&");
    const matches = [
      ...Array.from(source.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/ig), (match) => match[1]),
      ...Array.from(source.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/ig), (match) => match[1]),
      ...(source.match(/https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|sns-webpic-qc\.xhscdn\.com|ci\.xhscdn\.com|i\.ytimg\.com)\/[^\s，。；,;)）\]]+/ig) || [])
    ];
    const seen = new Set();
    return matches
      .map((url) => url.startsWith("//") ? "https:" + url : url)
      .map((url) => url.replace(/&amp;/g, "&"))
      .filter((url) => !seen.has(url) && seen.add(url))
      .slice(0, 8)
      .map((url) => ({ url, alt: "文章图片" }));
  }

  function textBlocks(text) {
    const source = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!source) return [];
    const pieces = source.includes("\n\n") ? source.split(/\n{2,}/) : source.split(/\n/);
    const blocks = [];
    for (const piece of pieces) {
      for (const raw of piece.split(/\n/)) {
        const line = raw.replace(/\s+/g, " ").trim();
        if (!line || /^https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|sns-webpic-qc\.xhscdn\.com|ci\.xhscdn\.com|i\.ytimg\.com)\//i.test(line) || /^图片[:：]?$/.test(line)) continue;
        const heading = /^(#{1,3}\s+|[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十]+[章节部分]|[0-9]{1,2}[、.]\s*)/.test(line) || (/[:：]$/.test(line) && line.length <= 32);
        const bullet = /^([-*•]|[0-9]{1,2}[.)])\s+/.test(line);
        blocks.push({ type: heading ? "heading" : bullet ? "bullet" : "paragraph", text: line.replace(/^#{1,3}\s+/, "") });
      }
    }
    return blocks.slice(0, 240);
  }

  function htmlEscape(value) {
    return String(value || "").replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function structuredHtml(text) {
    const blocks = textBlocks(text);
    if (!blocks.length) return '<p class="text-gray-300">暂无详细内容</p>';
    return blocks.map(function (block, index) {
      const safe = htmlEscape(block.text);
      if (block.type === "heading") {
        return '<section class="pt-2"><h3 class="text-base font-black text-gray-900 leading-snug">' + safe + '</h3></section>';
      }
      const bullet = block.type === "bullet" ? '<span class="mt-3 w-1.5 h-1.5 rounded-full bg-blue-300 shrink-0"></span>' : '';
      return '<div class="pickable-block rounded-2xl px-3 py-3 -mx-3 hover:bg-blue-50/60 transition-colors" data-index="' + index + '"><div class="flex items-start gap-3">' + bullet + '<p class="flex-1 leading-8 text-gray-600">' + safe + '</p></div></div>';
    }).join("");
  }

  function ensureDetailAddons() {
    const detail = document.getElementById("detail-view");
    if (!detail) return;
    const points = document.getElementById("detail-points");
    if (points && !document.getElementById("detail-picks")) {
      const picks = document.createElement("div");
      picks.id = "detail-picks";
      picks.className = "bg-yellow-50 rounded-3xl p-5 mb-8 text-sm text-yellow-900 leading-loose border border-yellow-100";
      points.insertAdjacentElement("afterend", picks);
    }
    if (!document.getElementById("smart-detail-back")) {
      const back = document.createElement("button");
      back.id = "smart-detail-back";
      back.className = "fixed bottom-6 left-6 z-30 h-11 px-5 rounded-full bg-gray-900 text-white text-sm font-black shadow-xl active:scale-95 transition-all";
      back.innerHTML = '<i class="fa-solid fa-arrow-left mr-2"></i>返回';
      back.onclick = function () { if (typeof window.closeDetail === "function") window.closeDetail(); };
      detail.appendChild(back);
    }
    if (!document.getElementById("selection-pick-toolbar")) {
      const toolbar = document.createElement("button");
      toolbar.id = "selection-pick-toolbar";
      toolbar.className = "hidden fixed bottom-20 left-1/2 -translate-x-1/2 z-40 h-12 px-5 rounded-full bg-yellow-400 text-gray-900 text-sm font-black shadow-xl active:scale-95 transition-all";
      toolbar.innerHTML = '<i class="fa-solid fa-highlighter mr-2"></i>加入我的 pick';
      toolbar.onclick = function (event) { event.stopPropagation(); saveSelectedPick(); };
      detail.appendChild(toolbar);
    }
    const firstBar = detail.querySelector(".p-8 > .flex.items-center.justify-between");
    if (firstBar && !firstBar.className.includes("sticky")) {
      firstBar.className = "sticky top-0 z-20 -mx-8 px-8 pt-4 pb-3 bg-white/90 backdrop-blur-md flex items-center justify-between mb-6";
    }
  }

  function renderPicksFor(id) {
    const box = document.getElementById("detail-picks");
    if (!box || !id) return;
    const note = (typeof state !== "undefined" && state.notes || []).find(function (item) { return item.id === id; }) || {};
    const picks = [...new Set([...(Array.isArray(note.picks) ? note.picks : []), ...readLocalPicks(id)].map(normalizePickText).filter(Boolean))];
    if (!picks.length) {
      box.innerHTML = '<div class="font-black text-gray-900 mb-2">我的 pick</div><p class="text-yellow-700/60">在正文里选中文字后，点底部“加入我的 pick”，就会汇总到这里。</p>';
      return;
    }
    box.innerHTML = '<div class="font-black text-gray-900 mb-3">我的 pick</div><div class="space-y-3">' + picks.map(function (pick, index) {
      return '<div class="rounded-2xl bg-white/70 border border-yellow-100 p-3"><div class="flex items-start gap-3"><i class="fa-solid fa-quote-left text-yellow-400 mt-1"></i><p class="flex-1 leading-7">' + htmlEscape(pick) + '</p><button data-index="' + index + '" class="smart-remove-pick shrink-0 w-8 h-8 rounded-full bg-yellow-100 text-yellow-700 active:scale-95"><i class="fa-solid fa-xmark"></i></button></div></div>';
    }).join("") + "</div>";
  }

  async function persistPicks(id, picks) {
    writeLocalPicks(id, picks);
    try {
      if (typeof api === "function") {
        const payload = await api("/api/notes/" + id, { method: "PATCH", body: JSON.stringify({ picks: picks }) });
        if (payload && payload.item && typeof replaceNote === "function") replaceNote(payload.item);
      }
    } catch {}
    renderPicksFor(id);
  }

  function selectedTextInDetail() {
    const selection = window.getSelection();
    const text = normalizePickText(selection && selection.toString());
    const body = document.getElementById("detail-body");
    if (!text || !selection || !selection.rangeCount || !body || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return "";
    return text;
  }

  function saveSelectedPick() {
    const id = typeof state !== "undefined" ? state.activeNoteId : "";
    const text = selectedTextInDetail();
    if (!id || !text) return;
    const picks = [...new Set([...readLocalPicks(id), text])];
    persistPicks(id, picks);
    window.getSelection().removeAllRanges();
    const toolbar = document.getElementById("selection-pick-toolbar");
    if (toolbar) toolbar.classList.add("hidden");
  }

  function bindDetailPatch() {
    if (window.__smartNoteDetailPatch) return;
    window.__smartNoteDetailPatch = true;
    const originalApi = typeof api === "function" ? api : null;
    if (originalApi && !window.__smartNoteDoubaoApiPatch) {
      window.__smartNoteDoubaoApiPatch = true;
      api = function patchedApi(path, options, retry) {
        const nextOptions = { ...(options || {}) };
        if (String(path || "") === "/api/content" && nextOptions.body) {
          try {
            const body = JSON.parse(nextOptions.body);
            if (isDoubaoUrl(body.url)) {
              body.category = body.category || "豆包";
              body.tags = [...new Set([...(Array.isArray(body.tags) ? body.tags : []), "豆包"])] ;
              nextOptions.body = JSON.stringify(body);
            }
          } catch {}
        }
        return originalApi(path, nextOptions, retry);
      };
      window.api = api;
    }
    const originalViewModel = typeof viewModel === "function" ? viewModel : null;
    if (originalViewModel && !window.__smartNoteDoubaoViewPatch) {
      window.__smartNoteDoubaoViewPatch = true;
      viewModel = function patchedViewModel(note) {
        const model = originalViewModel(note);
        const category = note && (note.category || note.coreInfo && note.coreInfo.sourceType || "");
        if (String(category).includes("豆包") || isDoubaoUrl(note && note.url || "")) {
          model.type = "doubao";
          model.typeLabel = "豆包";
          model.typeColor = "bg-orange-50 text-orange-600";
        }
        return model;
      };
      window.viewModel = viewModel;
    }
    const originalOpenDetail = typeof openDetail === "function" ? openDetail : null;
    if (originalOpenDetail) {
      openDetail = function patchedOpenDetail(data) {
        const enhanced = { ...data };
        const raw = enhanced.raw || {};
        const extractedImages = imageUrlsFromText([raw.sourceText, raw.body, enhanced.content].join("\n"));
        if (!enhanced.images || !enhanced.images.length) enhanced.images = extractedImages;
        enhanced.picks = [...new Set([...(Array.isArray(raw.picks) ? raw.picks : []), ...readLocalPicks(enhanced.id)].map(normalizePickText).filter(Boolean))];
        originalOpenDetail(enhanced);
        ensureDetailAddons();
        const imageBox = document.getElementById("detail-images");
        if (imageBox && enhanced.images && enhanced.images.length && typeof formatImages === "function") {
          imageBox.innerHTML = formatImages(enhanced.images);
          imageBox.classList.remove("hidden");
        }
        const body = document.getElementById("detail-body");
        if (body) body.innerHTML = structuredHtml(enhanced.content || raw.sourceText || raw.body || "");
        renderPicksFor(enhanced.id);
        const detail = document.getElementById("detail-view");
        if (detail) detail.scrollTop = 0;
      };
    }
    document.addEventListener("click", function (event) {
      const removeButton = event.target.closest(".smart-remove-pick");
      if (removeButton) {
        event.stopPropagation();
        const id = typeof state !== "undefined" ? state.activeNoteId : "";
        const picks = readLocalPicks(id);
        picks.splice(Number(removeButton.dataset.index), 1);
        if (id) persistPicks(id, picks);
      }
    });
    document.addEventListener("selectionchange", function () {
      const toolbar = document.getElementById("selection-pick-toolbar");
      if (!toolbar) return;
      const detail = document.getElementById("detail-view");
      toolbar.classList.toggle("hidden", !detail || detail.classList.contains("hidden") || !selectedTextInDetail());
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { bind(); bindDetailPatch(); }, { once: true });
  } else {
    bind();
    bindDetailPatch();
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
