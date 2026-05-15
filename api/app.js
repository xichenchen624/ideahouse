import fs from 'node:fs/promises';
import path from 'node:path';

const RUNTIME_PATCH = String.raw`
<script data-smart-note-runtime-patch>
(function () {
  function $(id) { return document.getElementById(id); }
  function esc(value) { return String(value || '').replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function status(message, err) { if (typeof setStatus === 'function') setStatus(message, err); }
  function manual() { return $('manual-text-input'); }
  function modal() { return $('add-modal'); }
  function findInsightNav() { return Array.from(document.querySelectorAll('nav > *')).find(function (el) { return el.textContent && el.textContent.includes('灵感'); }); }
  function normalizePick(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500); }
  function pickKey(id) { return 'smart-note-picks:' + id; }
  function readPicks(id) { try { return JSON.parse(localStorage.getItem(pickKey(id)) || '[]').map(normalizePick).filter(Boolean); } catch { return []; } }
  function writePicks(id, picks) { localStorage.setItem(pickKey(id), JSON.stringify([...new Set(picks.map(normalizePick).filter(Boolean))])); }

  function ensureExpandButton() {
    const panel = $('manual-input-panel');
    if (!panel) return null;
    let button = $('ai-expand-btn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'ai-expand-btn';
      button.type = 'button';
      button.className = 'hidden mt-3 w-full bg-gray-900 text-white py-3 rounded-2xl font-black text-sm shadow-lg shadow-gray-100 active:scale-95 transition-all items-center justify-center gap-2';
      button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>AI 扩写</span>';
      panel.appendChild(button);
      button.addEventListener('click', expandInsight);
    }
    return button;
  }

  function setInsightMode(on) {
    const m = modal();
    const input = manual();
    const expand = ensureExpandButton();
    if (!m) return;
    m.dataset.mode = on ? 'insight' : 'link';
    const title = m.querySelector('h2');
    const sub = title && title.nextElementSibling;
    const urlInput = $('url-input');
    const urlPanel = urlInput && urlInput.closest('.bg-gray-50');
    const manualPanel = $('manual-input-panel');
    const labels = manualPanel ? manualPanel.querySelectorAll('span') : [];
    if (title) title.textContent = on ? '记录灵感' : '添加新内容';
    if (sub) sub.textContent = on ? '写下想法、摘录或待整理笔记' : '支持公众号、小红书或视频链接';
    if (urlPanel) urlPanel.classList.toggle('hidden', on);
    if (manualPanel) manualPanel.classList.toggle('hidden', !on);
    if (expand) { expand.classList.toggle('hidden', !on); expand.classList.toggle('flex', on); }
    if (labels[0]) labels[0].textContent = on ? '灵感正文' : '正文/摘录';
    if (labels[1]) labels[1].textContent = on ? '保存到灵感' : '公众号、小红书读不到时填写';
    if (input) input.placeholder = on ? '写下当前想法、摘录、待办或稍后要整理的内容...' : '粘贴文章正文、分享文案或你想保留的重点摘录...';
    const submit = $('submit-btn');
    if (submit) submit.innerHTML = on ? '<i class="fa-solid fa-wand-sparkles"></i><span>保存灵感</span>' : '<i class="fa-solid fa-bolt-lightning"></i><span>开始智能提取</span>';
  }

  window.openInsightModal = function () {
    if (typeof window.openAddModal === 'function') window.openAddModal();
    setInsightMode(true);
    setTimeout(function () { if (manual()) manual().focus(); }, 80);
  };

  const oldClose = window.closeAddModal;
  if (typeof oldClose === 'function' && !oldClose.__runtimePatched) {
    window.closeAddModal = function () { oldClose(); setInsightMode(false); };
    window.closeAddModal.__runtimePatched = true;
  }

  async function expandInsight(event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const input = manual();
    const text = input ? input.value.trim() : '';
    const button = ensureExpandButton();
    if (!text) { status('请先写下一点灵感，再让 AI 扩写', true); if (input) input.focus(); return; }
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-circle-notch animate-spin"></i><span>GPT-5.5 扩写中...</span>'; }
    status('正在用 GPT-5.5 扩写灵感...');
    try {
      const payload = await api('/api/expand', { method: 'POST', body: JSON.stringify({ text: text, mode: 'insight' }) });
      if (input && payload.expandedText) input.value = payload.expandedText;
      status('AI 扩写完成，可以继续修改后保存');
    } catch (error) {
      status(error && error.message ? error.message : 'AI 扩写失败，请稍后再试', true);
    } finally {
      if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i><span>AI 扩写</span>'; }
    }
  }
  window.expandInsight = expandInsight;

  async function submitInsight(event) {
    const m = modal();
    if (!m || m.dataset.mode !== 'insight') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = manual();
    const text = input ? input.value.trim() : '';
    if (!text) { status('请先写下灵感内容', true); return; }
    if (typeof setSubmitBusy === 'function') setSubmitBusy(true);
    status('正在保存灵感...');
    try {
      const payload = await api('/api/notes', { method: 'POST', body: JSON.stringify({ body: text, favorite: false, category: '灵感' }) });
      if (typeof loadNotes === 'function') await loadNotes();
      if (typeof closeAddModal === 'function') closeAddModal();
      if (payload.item && typeof openDetail === 'function' && typeof viewModel === 'function') openDetail(viewModel(payload.item));
    } catch (error) {
      status(error && error.message ? error.message : '保存失败，请稍后再试', true);
    } finally {
      if (typeof setSubmitBusy === 'function') setSubmitBusy(false);
    }
  }

  function imageUrls(text) {
    const source = String(text || '').replace(/&amp;/g, '&');
    const urls = [
      ...Array.from(source.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/ig), function (m) { return m[1]; }),
      ...Array.from(source.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/ig), function (m) { return m[1]; }),
      ...(source.match(/https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|sns-webpic-qc\.xhscdn\.com|ci\.xhscdn\.com|i\.ytimg\.com)\/[^\s，。；,;)）\]]+/ig) || [])
    ];
    const seen = new Set();
    return urls.map(function (u) { return u.startsWith('//') ? 'https:' + u : u; }).filter(function (u) { return !seen.has(u) && seen.add(u); }).slice(0, 8).map(function (u) { return { url: u, alt: '文章图片' }; });
  }

  function blocks(text) {
    return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').split(/\n{2,}|\n/).map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).filter(function (line) { return line && !/^图片[:：]?$/.test(line) && !/^https?:\/\/(?:mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|sns-webpic-qc\.xhscdn\.com|ci\.xhscdn\.com|i\.ytimg\.com)\//i.test(line); }).slice(0, 240);
  }

  function structured(text) {
    const rows = blocks(text);
    if (!rows.length) return '<p class="text-gray-300">暂无详细内容</p>';
    return rows.map(function (line, index) {
      const heading = /^(#{1,3}\s+|[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十]+[章节部分]|[0-9]{1,2}[、.]\s*)/.test(line) || (/[:：]$/.test(line) && line.length <= 32);
      const bullet = /^([-*•]|[0-9]{1,2}[.)])\s+/.test(line);
      const safe = esc(line.replace(/^#{1,3}\s+/, ''));
      if (heading) return '<section class="pt-2"><h3 class="text-base font-black text-gray-900 leading-snug">' + safe + '</h3></section>';
      return '<div class="pickable-block rounded-2xl px-3 py-3 -mx-3 hover:bg-blue-50/60 transition-colors"><div class="flex items-start gap-3">' + (bullet ? '<span class="mt-3 w-1.5 h-1.5 rounded-full bg-blue-300 shrink-0"></span>' : '') + '<p class="flex-1 leading-8 text-gray-600">' + safe + '</p><button data-pick="' + safe + '" class="smart-pick-btn shrink-0 mt-1 px-2.5 py-1 rounded-full bg-yellow-50 text-yellow-600 text-[10px] font-black">Pick</button></div></div>';
    }).join('');
  }

  function ensureDetail() {
    const detail = $('detail-view');
    if (!detail) return;
    const points = $('detail-points');
    if (points && !$('detail-picks')) {
      const p = document.createElement('div');
      p.id = 'detail-picks';
      p.className = 'bg-yellow-50 rounded-3xl p-5 mb-8 text-sm text-yellow-900 leading-loose border border-yellow-100';
      points.insertAdjacentElement('afterend', p);
    }
    if (!$('smart-detail-back')) {
      const b = document.createElement('button');
      b.id = 'smart-detail-back';
      b.className = 'fixed bottom-6 left-6 z-30 h-11 px-5 rounded-full bg-gray-900 text-white text-sm font-black shadow-xl active:scale-95 transition-all';
      b.innerHTML = '<i class="fa-solid fa-arrow-left mr-2"></i>返回';
      b.onclick = function () { if (typeof closeDetail === 'function') closeDetail(); };
      detail.appendChild(b);
    }
    const top = detail.querySelector('.p-8 > .flex.items-center.justify-between');
    if (top && !top.className.includes('sticky')) top.className = 'sticky top-0 z-20 -mx-8 px-8 pt-4 pb-3 bg-white/90 backdrop-blur-md flex items-center justify-between mb-6';
  }

  function renderPicks(id) {
    const box = $('detail-picks');
    if (!box || !id) return;
    const note = (typeof state !== 'undefined' && state.notes || []).find(function (n) { return n.id === id; }) || {};
    const picks = [...new Set([...(Array.isArray(note.picks) ? note.picks : []), ...readPicks(id)].map(normalizePick).filter(Boolean))];
    box.innerHTML = '<div class="font-black text-gray-900 mb-2">我的 pick</div>' + (picks.length ? '<div class="space-y-3">' + picks.map(function (p, i) { return '<div class="rounded-2xl bg-white/70 border border-yellow-100 p-3 flex gap-3"><i class="fa-solid fa-quote-left text-yellow-400 mt-1"></i><p class="flex-1 leading-7">' + esc(p) + '</p><button data-index="' + i + '" class="smart-remove-pick shrink-0 w-8 h-8 rounded-full bg-yellow-100 text-yellow-700"><i class="fa-solid fa-xmark"></i></button></div>'; }).join('') + '</div>' : '<p class="text-yellow-700/60">在正文里点段落右侧的 Pick，就会汇总到这里。</p>');
  }

  async function persistPick(id, text) {
    const pick = normalizePick(text);
    if (!id || !pick) return;
    const picks = [...new Set([...readPicks(id), pick])];
    writePicks(id, picks);
    try { if (typeof api === 'function') await api('/api/notes/' + id, { method: 'PATCH', body: JSON.stringify({ picks: picks }) }); } catch {}
    renderPicks(id);
  }

  function patchDetail() {
    if (window.__smartDetailRuntimePatch || typeof openDetail !== 'function') return;
    window.__smartDetailRuntimePatch = true;
    const oldOpen = openDetail;
    openDetail = function (data) {
      const raw = data.raw || {};
      if (!data.images || !data.images.length) data.images = imageUrls([raw.sourceText, raw.body, data.content].join('\n'));
      oldOpen(data);
      ensureDetail();
      const img = $('detail-images');
      if (img && data.images && data.images.length && typeof formatImages === 'function') { img.innerHTML = formatImages(data.images); img.classList.remove('hidden'); }
      const body = $('detail-body');
      if (body) body.innerHTML = structured(data.content || raw.sourceText || raw.body || '');
      renderPicks(data.id);
      const detail = $('detail-view');
      if (detail) detail.scrollTop = 0;
    };
    document.addEventListener('click', function (event) {
      const pick = event.target.closest('.smart-pick-btn');
      if (pick) { event.stopPropagation(); persistPick(state && state.activeNoteId, pick.dataset.pick || ''); }
      const remove = event.target.closest('.smart-remove-pick');
      if (remove && state && state.activeNoteId) { const picks = readPicks(state.activeNoteId); picks.splice(Number(remove.dataset.index), 1); writePicks(state.activeNoteId, picks); renderPicks(state.activeNoteId); }
    });
  }

  function bind() {
    const nav = findInsightNav();
    if (nav) { nav.onclick = window.openInsightModal; nav.classList.add('cursor-pointer', 'active:scale-95', 'transition-all'); nav.setAttribute('role', 'button'); }
    ensureExpandButton();
    const submit = $('submit-btn');
    if (submit && !submit.dataset.runtimeInsight) { submit.dataset.runtimeInsight = 'true'; submit.addEventListener('click', submitInsight, true); }
    patchDetail();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
</script>`;

export default async function handler(req, res) {
  const indexPath = path.join(process.cwd(), 'public', 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  if (!html.includes('data-smart-note-runtime-patch')) {
    html = html.replace('</body>', `${RUNTIME_PATCH}\n</body>`);
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(html);
}
