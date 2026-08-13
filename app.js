(function () {
  // ---------- アクセスゲート ----------
  const gate = document.getElementById('gate');
  const app = document.getElementById('app');
  const gateInput = document.getElementById('gateInput');
  const gateBtn = document.getElementById('gateBtn');
  const gateError = document.getElementById('gateError');

  function tryUnlock(code) {
    if (code === ACCESS_CODE) {
      localStorage.setItem('mydrop_unlocked', '1');
      gate.style.display = 'none';
      app.style.display = 'block';
      init();
    } else {
      gateError.textContent = 'コードが違います';
    }
  }
  gateBtn.addEventListener('click', () => tryUnlock(gateInput.value));
  gateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(gateInput.value); });

  if (localStorage.getItem('mydrop_unlocked') === '1') {
    gate.style.display = 'none';
    app.style.display = 'block';
    init();
  }

  // ---------- Supabase ----------
  let supabase;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function init() {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const textInput = document.getElementById('textInput');
    const sendBtn = document.getElementById('sendBtn');
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    const previewArea = document.getElementById('previewArea');
    const list = document.getElementById('list');
    const emptyMsg = document.getElementById('emptyMsg');
    const statusText = document.getElementById('statusText');

    let items = [];
    let pendingImages = [];

    function autoGrow() {
      textInput.style.height = 'auto';
      textInput.style.height = Math.min(textInput.scrollHeight, 160) + 'px';
    }
    textInput.addEventListener('input', () => {
      autoGrow();
      sendBtn.disabled = !textInput.value.trim() && pendingImages.length === 0;
    });
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      statusText.textContent = files.length > 1 ? `画像を処理中…（0/${files.length}）` : '画像を処理中…';
      let done = 0;
      for (const file of files) {
        try {
          const { blob, dataUrl } = await compressImage(file);
          pendingImages.push({ blob, dataUrl });
        } catch (err) {}
        done++;
        if (files.length > 1) statusText.textContent = `画像を処理中…（${done}/${files.length}）`;
      }
      renderPreview();
      sendBtn.disabled = pendingImages.length === 0 && !textInput.value.trim();
      statusText.textContent = '';
      fileInput.value = '';
    });

    function renderPreview() {
      previewArea.innerHTML = '';
      if (!pendingImages.length) return;
      const listWrap = document.createElement('div');
      listWrap.className = 'preview-list';
      pendingImages.forEach((p, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'preview-thumb';
        const img = document.createElement('img');
        img.src = p.dataUrl;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-x';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => {
          pendingImages.splice(idx, 1);
          renderPreview();
          sendBtn.disabled = pendingImages.length === 0 && !textInput.value.trim();
        };
        wrap.appendChild(img);
        wrap.appendChild(removeBtn);
        listWrap.appendChild(wrap);
      });
      previewArea.appendChild(listWrap);
      if (pendingImages.length > 1) {
        const count = document.createElement('div');
        count.className = 'preview-count';
        count.textContent = `${pendingImages.length}枚選択中（1枚ずつ個別のメッセージとして送信されます）`;
        previewArea.appendChild(count);
      }
    }

    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
            const maxDim = 1600;
            if (width > maxDim || height > maxDim) {
              if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
              else { width = Math.round(width * maxDim / height); height = maxDim; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob((blob) => {
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              resolve({ blob, dataUrl });
            }, 'image/jpeg', 0.85);
          };
          img.onerror = reject;
          img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    async function handleSend() {
      const text = textInput.value.trim();
      const images = pendingImages.slice();
      if (!text && images.length === 0) return;
      sendBtn.disabled = true;
      let failCount = 0;
      try {
        if (text) {
          const { error } = await supabase.from('drop_items').insert({ type: 'text', content: text });
          if (!error) { textInput.value = ''; autoGrow(); await refresh(); }
        }
        for (let i = 0; i < images.length; i++) {
          statusText.textContent = images.length > 1 ? `送信中…（${i + 1}/${images.length}）` : '送信中…';
          const path = `${uid()}.jpg`;
          const { error: upErr } = await supabase.storage.from('drop-images').upload(path, images[i].blob, { contentType: 'image/jpeg' });
          if (upErr) { failCount++; continue; }
          const { error: insErr } = await supabase.from('drop_items').insert({ type: 'image', image_path: path });
          if (insErr) { failCount++; continue; }
          pendingImages = pendingImages.filter(p => p !== images[i]);
          renderPreview();
          await refresh();
          if (i < images.length - 1) await sleep(200);
        }
        statusText.textContent = failCount > 0 ? `${failCount}件の送信に失敗しました` : '';
      } catch (err) {
        statusText.textContent = '送信に失敗しました';
      }
      sendBtn.disabled = !textInput.value.trim() && pendingImages.length === 0;
    }
    document.getElementById('sendBtn').addEventListener('click', handleSend);

    function formatTime(ts) {
      const d = new Date(ts);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      if (sameDay) return time;
      return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + ' ' + time;
    }

    async function deleteItem(it) {
      await supabase.from('drop_items').delete().eq('id', it.id);
      if (it.type === 'image' && it.image_path) {
        await supabase.storage.from('drop-images').remove([it.image_path]);
      }
      await refresh();
    }

    function flashSuccess(el) {
      const prev = el.style.filter;
      el.style.filter = 'brightness(0.9)';
      setTimeout(() => { el.style.filter = prev || ''; }, 200);
    }

    function copyText(text, feedbackEl) {
      navigator.clipboard.writeText(text).then(() => {
        statusText.textContent = 'コピーしました';
        if (feedbackEl) flashSuccess(feedbackEl);
        setTimeout(() => { if (statusText.textContent === 'コピーしました') statusText.textContent = ''; }, 1200);
      }).catch(() => { statusText.textContent = 'コピーに失敗しました'; });
    }

    function dataURLtoBlob(dataUrl) {
      const parts = dataUrl.split(',');
      const mime = (parts[0].match(/:(.*?);/) || [, 'image/jpeg'])[1];
      const binary = atob(parts[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }

    function copyImage(url, feedbackEl) {
      const manualWin = window.open('', '_blank');
      fetch(url).then(r => r.blob()).then(async (blob) => {
        try {
          if (navigator.clipboard && window.ClipboardItem) {
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            if (manualWin && !manualWin.closed) manualWin.close();
            statusText.textContent = 'コピーしました';
            if (feedbackEl) flashSuccess(feedbackEl);
            setTimeout(() => { if (statusText.textContent === 'コピーしました') statusText.textContent = ''; }, 1500);
            return;
          }
          throw new Error('unsupported');
        } catch (e) {
          populateManualCopyWindow(manualWin, url);
        }
      }).catch(() => populateManualCopyWindow(manualWin, url));
    }

    function populateManualCopyWindow(win, url) {
      if (!win) {
        statusText.textContent = 'ポップアップがブロックされています';
        setTimeout(() => { statusText.textContent = ''; }, 2000);
        return;
      }
      win.document.title = '画像をコピー';
      win.document.body.style.margin = '0';
      win.document.body.style.background = '#111';
      win.document.body.innerHTML =
        '<div style="color:#fff;font-family:sans-serif;font-size:14px;text-align:center;padding:10px;">この画像を長押し（またはPCなら右クリック）して「画像をコピー」を選んでください</div>' +
        '<img src="' + url + '" style="display:block;max-width:100%;margin:0 auto;">';
    }

    function render() {
      list.innerHTML = '';
      emptyMsg.style.display = items.length === 0 ? 'block' : 'none';
      items.forEach(it => {
        const row = document.createElement('div');
        row.className = 'item-row';

        const content = document.createElement('div');
        content.className = 'item-content';
        const meta = document.createElement('div');
        meta.className = 'item-meta';
        meta.textContent = formatTime(it.created_at);
        content.appendChild(meta);

        const actionsSide = document.createElement('div');
        actionsSide.className = 'item-actions-side';

        if (it.type === 'text') {
          const t = document.createElement('div');
          t.className = 'bubble-text';
          t.textContent = it.content;
          t.onclick = () => copyText(it.content, t);
          content.appendChild(t);

          const copyBtn = document.createElement('button');
          copyBtn.textContent = 'コピー';
          copyBtn.onclick = (e) => { e.stopPropagation(); copyText(it.content, copyBtn); };
          actionsSide.appendChild(copyBtn);
        } else {
          const url = supabase.storage.from('drop-images').getPublicUrl(it.image_path).data.publicUrl;
          const bubble = document.createElement('div');
          bubble.className = 'bubble-image';
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = url;
          bubble.onclick = () => copyImage(url, bubble);
          bubble.appendChild(img);
          content.appendChild(bubble);

          const copyBtn = document.createElement('button');
          copyBtn.textContent = 'コピー';
          copyBtn.onclick = (e) => { e.stopPropagation(); copyImage(url, copyBtn); };
          actionsSide.appendChild(copyBtn);

          const dlBtn = document.createElement('button');
          dlBtn.textContent = '保存';
          dlBtn.onclick = (e) => {
            e.stopPropagation();
            const a = document.createElement('a');
            a.href = url;
            a.download = it.image_path || 'drop.jpg';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          };
          actionsSide.appendChild(dlBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'del';
        delBtn.textContent = '削除';
        delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(it); };
        actionsSide.appendChild(delBtn);

        row.appendChild(actionsSide);
        row.appendChild(content);
        list.appendChild(row);
      });
    }

    async function refresh() {
      try {
        const { data, error } = await supabase
          .from('drop_items')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200);
        if (!error && data) {
          items = data;
          render();
        }
        statusText.textContent = statusText.textContent || '';
      } catch (e) {}
    }

    refresh();
    setInterval(refresh, 4000);
  }
})();
