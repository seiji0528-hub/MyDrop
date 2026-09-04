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

  // （自動ロック解除は、必要な変数の準備が整うファイル末尾で行います）

  // ---------- Supabase ----------
  let supabase;
  const MAX_VIDEO_MB = 15; // 動画1本あたりの上限（無料枠を圧迫しないための目安）
  const DEVICE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'phone' : 'pc';

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function init() {
    if (!window.supabase) {
      showFatal('Supabaseライブラリの読み込みに失敗しました。ネットワーク接続を確認してください。');
      return;
    }
    if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT-ID')) {
      showFatal('config.js の SUPABASE_URL が未設定です。');
      return;
    }
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('YOUR-ANON-PUBLIC-KEY')) {
      showFatal('config.js の SUPABASE_ANON_KEY が未設定です。');
      return;
    }

    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const textInput = document.getElementById('textInput');
    const sendBtn = document.getElementById('sendBtn');
    const attachBtn = document.getElementById('attachBtn');
    const fileInput = document.getElementById('fileInput');
    const previewArea = document.getElementById('previewArea');
    const list = document.getElementById('list');
    const emptyMsg = document.getElementById('emptyMsg');
    const statusText = document.getElementById('statusText');

    function showFatal(msg) {
      const s = document.getElementById('statusText');
      if (s) s.textContent = msg;
      console.error('[MyDrop]', msg);
    }

    function showError(prefix, err) {
      const msg = (err && (err.message || err.error_description || err.hint)) || String(err) || '不明なエラー';
      statusText.textContent = prefix + '：' + msg;
      console.error('[MyDrop]', prefix, err);
    }

    let items = [];
    let pendingFiles = []; // [{kind:'image'|'video', blob, dataUrl?, name}]

    function autoGrow() {
      textInput.style.height = 'auto';
      textInput.style.height = Math.min(textInput.scrollHeight, 160) + 'px';
    }
    textInput.addEventListener('input', () => {
      autoGrow();
      sendBtn.disabled = !textInput.value.trim() && pendingFiles.length === 0;
    });
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      statusText.textContent = files.length > 1 ? `処理中…（0/${files.length}）` : '処理中…';
      let done = 0;
      for (const file of files) {
        try {
          if (file.type.startsWith('video/')) {
            const sizeMB = file.size / (1024 * 1024);
            if (sizeMB > MAX_VIDEO_MB) {
              statusText.textContent = `「${file.name}」は${sizeMB.toFixed(1)}MBあり、上限${MAX_VIDEO_MB}MBを超えています（スキップしました）`;
              await sleep(1500);
            } else {
              pendingFiles.push({ kind: 'video', blob: file, name: file.name });
            }
          } else if (file.type.startsWith('image/')) {
            const { blob, dataUrl } = await compressImage(file);
            pendingFiles.push({ kind: 'image', blob, dataUrl, name: file.name });
          }
        } catch (err) {
          console.error('[MyDrop] file processing error', err);
        }
        done++;
        if (files.length > 1) statusText.textContent = `処理中…（${done}/${files.length}）`;
      }
      renderPreview();
      sendBtn.disabled = pendingFiles.length === 0 && !textInput.value.trim();
      statusText.textContent = '';
      fileInput.value = '';
    });

    function renderPreview() {
      previewArea.innerHTML = '';
      if (!pendingFiles.length) return;
      const listWrap = document.createElement('div');
      listWrap.className = 'preview-list';
      pendingFiles.forEach((p, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'preview-thumb';
        if (p.kind === 'image') {
          const img = document.createElement('img');
          img.src = p.dataUrl;
          wrap.appendChild(img);
        } else {
          const vBox = document.createElement('div');
          vBox.style.cssText = 'width:56px;height:56px;border-radius:8px;background:#222;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;';
          vBox.textContent = '動画';
          wrap.appendChild(vBox);
        }
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-x';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => {
          pendingFiles.splice(idx, 1);
          renderPreview();
          sendBtn.disabled = pendingFiles.length === 0 && !textInput.value.trim();
        };
        wrap.appendChild(removeBtn);
        listWrap.appendChild(wrap);
      });
      previewArea.appendChild(listWrap);
      if (pendingFiles.length > 1) {
        const count = document.createElement('div');
        count.className = 'preview-count';
        count.textContent = `${pendingFiles.length}件選択中（1件ずつ個別のメッセージとして送信されます）`;
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
              if (!blob) { reject(new Error('画像の圧縮に失敗しました')); return; }
              const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
              resolve({ blob, dataUrl });
            }, 'image/jpeg', 0.85);
          };
          img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
          img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
        reader.readAsDataURL(file);
      });
    }

    async function handleSend() {
      const text = textInput.value.trim();
      const files = pendingFiles.slice();
      if (!text && files.length === 0) return;
      sendBtn.disabled = true;

      try {
        if (text) {
          statusText.textContent = '送信中…';
          const { error } = await supabase.from('drop_items').insert({ type: 'text', content: text, device: DEVICE });
          if (error) {
            showError('テキストの送信に失敗しました', error);
          } else {
            textInput.value = '';
            autoGrow();
            statusText.textContent = '';
            await refresh();
          }
        }

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          statusText.textContent = files.length > 1 ? `送信中…（${i + 1}/${files.length}）` : '送信中…';
          const ext = f.kind === 'video' ? (f.name.split('.').pop() || 'mp4') : 'jpg';
          const path = `${uid()}.${ext}`;
          const contentType = f.kind === 'video' ? (f.blob.type || 'video/mp4') : 'image/jpeg';

          const { error: upErr } = await supabase.storage.from('drop-images').upload(path, f.blob, { contentType });
          if (upErr) {
            showError((f.kind === 'video' ? '動画' : '画像') + 'のアップロードに失敗しました', upErr);
            continue;
          }
          const { error: insErr } = await supabase.from('drop_items').insert({ type: f.kind, image_path: path, device: DEVICE });
          if (insErr) {
            showError('データベースへの登録に失敗しました', insErr);
            continue;
          }
          pendingFiles = pendingFiles.filter(p => p !== f);
          renderPreview();
          await refresh();
          statusText.textContent = '';
          if (i < files.length - 1) await sleep(200);
        }
      } catch (err) {
        showError('送信に失敗しました', err);
      }
      sendBtn.disabled = !textInput.value.trim() && pendingFiles.length === 0;
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
      const { error } = await supabase.from('drop_items').delete().eq('id', it.id);
      if (error) { showError('削除に失敗しました', error); return; }
      if ((it.type === 'image' || it.type === 'video') && it.image_path) {
        await supabase.storage.from('drop-images').remove([it.image_path]);
      }
      await refresh();
    }

    function flashSuccess(el) {
      const prev = el.style.filter;
      el.style.filter = 'brightness(0.9)';
      setTimeout(() => { el.style.filter = prev || ''; }, 200);
    }

    // 画像データを取得する。既に読み込み済みの<img>があればcanvas経由（fetchのCORS問題を回避できるため優先）
    async function getBlobForItem(url, imgEl) {
      // 既に読み込み済みの<img>があればcanvas経由（fetchのCORS問題を回避できるため優先）
      let sourceImg = (imgEl && imgEl.complete && imgEl.naturalWidth) ? imgEl : null;
      if (!sourceImg) {
        try {
          sourceImg = await new Promise((resolve, reject) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
            im.src = url;
          });
        } catch (e) {
          sourceImg = null;
        }
      }
      if (sourceImg) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = sourceImg.naturalWidth;
          canvas.height = sourceImg.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(sourceImg, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (blob) return blob; // 常にimage/pngとして統一される
        } catch (e) { /* CORSでcanvasが汚染された場合はfetchにフォールバック */ }
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('データの取得に失敗しました（' + res.status + '）');
      return await res.blob();
    }

    // 保存：スマホでは共有シート（写真アプリへの保存が選べる）、それが使えない環境ではダウンロード
    async function shareOrDownload(url, filename, imgEl) {
      let blob;
      try {
        blob = await getBlobForItem(url, imgEl);
      } catch (err) {
        showError('保存に失敗しました', err);
        return;
      }
      try {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return; // 共有シートをキャンセルしただけなのでエラー表示しない
        // 共有に失敗した場合は通常のダウンロードにフォールバック
      }
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    }

    function copyText(text, feedbackEl) {
      navigator.clipboard.writeText(text).then(() => {
        statusText.textContent = 'コピーしました';
        if (feedbackEl) flashSuccess(feedbackEl);
        setTimeout(() => { if (statusText.textContent === 'コピーしました') statusText.textContent = ''; }, 1200);
      }).catch((err) => showError('コピーに失敗しました', err));
    }

    // 画像コピー：iOS Safari等は「クリックした瞬間に同期的にclipboard.writeを呼ぶ」必要があるため、
    // データ取得を待たずに、Promiseそのものをclipboard.writeへ渡す形にしている
    function copyImage(url, imgEl, feedbackEl) {
      if (!(navigator.clipboard && window.ClipboardItem)) {
        const w = window.open('', '_blank');
        populateManualCopyWindow(w, url);
        return;
      }
      try {
        const blobPromise = getBlobForItem(url, imgEl);
        const item = new ClipboardItem({ 'image/png': blobPromise });
        navigator.clipboard.write([item]).then(() => {
          statusText.textContent = 'コピーしました';
          if (feedbackEl) flashSuccess(feedbackEl);
          setTimeout(() => { if (statusText.textContent === 'コピーしました') statusText.textContent = ''; }, 1500);
        }).catch((err) => {
          console.error('[MyDrop] clipboard write failed', err);
          const w = window.open('', '_blank');
          populateManualCopyWindow(w, url);
        });
      } catch (err) {
        console.error('[MyDrop] copyImage error', err);
        const w = window.open('', '_blank');
        populateManualCopyWindow(w, url);
      }
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

    // 画像を大きく表示し、ピンチ／ホイールで拡大縮小できるビューアー
    function openLightbox(url, imgElForCopy, filename) {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;';

      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'max-width:92vw;max-height:78vh;touch-action:none;user-select:none;' +
        'transform-origin:center center;cursor:grab;';
      overlay.appendChild(img);

      let scale = 1, tx = 0, ty = 0;
      function applyTransform() {
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      }

      const pointers = new Map();
      let startDist = 0, startScale = 1, panStart = null, startTxTy = null;

      img.addEventListener('pointerdown', (e) => {
        img.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          panStart = { x: e.clientX, y: e.clientY };
          startTxTy = { x: tx, y: ty };
        } else if (pointers.size === 2) {
          const pts = [...pointers.values()];
          startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          startScale = scale;
        }
      });
      img.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const pts = [...pointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (startDist > 0) {
            scale = Math.min(5, Math.max(1, startScale * (dist / startDist)));
            applyTransform();
          }
        } else if (pointers.size === 1 && panStart) {
          tx = startTxTy.x + (e.clientX - panStart.x);
          ty = startTxTy.y + (e.clientY - panStart.y);
          applyTransform();
        }
      });
      function endPointer(e) {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) startDist = 0;
        if (pointers.size === 0) panStart = null;
      }
      img.addEventListener('pointerup', endPointer);
      img.addEventListener('pointercancel', endPointer);
      img.addEventListener('pointerleave', endPointer);

      let lastTap = 0;
      img.addEventListener('pointerup', () => {
        const now = Date.now();
        if (now - lastTap < 300 && pointers.size === 0) {
          if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = 2; }
          applyTransform();
        }
        lastTap = now;
      });

      overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        scale = Math.min(5, Math.max(1, scale - e.deltaY * 0.0015));
        applyTransform();
      }, { passive: false });

      const toolbar = document.createElement('div');
      toolbar.style.cssText = 'position:absolute;top:14px;right:14px;display:flex;gap:8px;';
      function mkBtn(label) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:8px 14px;border-radius:20px;border:none;background:rgba(255,255,255,0.18);' +
          'color:#fff;font-size:13px;cursor:pointer;';
        return b;
      }
      const closeBtn = mkBtn('閉じる');
      closeBtn.onclick = () => overlay.remove();
      const copyBtn = mkBtn('コピー');
      copyBtn.onclick = () => copyImage(url, imgElForCopy, copyBtn);
      const saveBtn = mkBtn('保存');
      saveBtn.onclick = () => shareOrDownload(url, filename || 'drop.jpg', imgElForCopy);
      toolbar.appendChild(copyBtn);
      toolbar.appendChild(saveBtn);
      toolbar.appendChild(closeBtn);
      overlay.appendChild(toolbar);

      const hint = document.createElement('div');
      hint.style.cssText = 'position:absolute;bottom:16px;left:0;right:0;text-align:center;' +
        'color:rgba(255,255,255,0.6);font-size:11px;padding:0 24px;';
      hint.textContent = 'ピンチ操作（PCはスクロール）で拡大縮小できます。うまくコピーできない場合は、この画面のままスクリーンショット（Windowsは Win+Shift+S のSnipping Tool）も使えます';
      overlay.appendChild(hint);

      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }

    function render() {
      list.innerHTML = '';
      emptyMsg.style.display = items.length === 0 ? 'block' : 'none';
      items.forEach(it => {
        const row = document.createElement('div');
        const isMine = !it.device || it.device === DEVICE;
        row.className = 'item-row' + (isMine ? '' : ' other-device');

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
        } else if (it.type === 'video') {
          const url = supabase.storage.from('drop-images').getPublicUrl(it.image_path).data.publicUrl;
          const bubble = document.createElement('div');
          bubble.className = 'bubble-image';
          bubble.style.cursor = 'default';
          const video = document.createElement('video');
          video.src = url;
          video.controls = true;
          video.style.width = '100%';
          video.style.display = 'block';
          bubble.appendChild(video);
          content.appendChild(bubble);

          const dlBtn = document.createElement('button');
          dlBtn.textContent = '保存';
          dlBtn.onclick = (e) => {
            e.stopPropagation();
            shareOrDownload(url, it.image_path || 'drop.mp4', null);
          };
          actionsSide.appendChild(dlBtn);
        } else {
          const url = supabase.storage.from('drop-images').getPublicUrl(it.image_path).data.publicUrl;
          const bubble = document.createElement('div');
          bubble.className = 'bubble-image';
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.crossOrigin = 'anonymous';
          img.src = url;
          bubble.onclick = () => openLightbox(url, img, it.image_path || 'drop.jpg');
          bubble.appendChild(img);
          content.appendChild(bubble);

          const copyBtn = document.createElement('button');
          copyBtn.textContent = 'コピー';
          copyBtn.onclick = (e) => { e.stopPropagation(); copyImage(url, img, copyBtn); };
          actionsSide.appendChild(copyBtn);

          const dlBtn = document.createElement('button');
          dlBtn.textContent = '保存';
          dlBtn.onclick = (e) => {
            e.stopPropagation();
            shareOrDownload(url, it.image_path || 'drop.jpg', img);
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
        if (error) {
          showError('読み込みに失敗しました', error);
          return;
        }
        items = data || [];
        render();
        if (statusText.textContent === '読み込み中…') statusText.textContent = '';
      } catch (e) {
        showError('読み込みに失敗しました', e);
      }
    }

    refresh();
    setInterval(refresh, 4000);
  }

  // 前回アクセスコードを入力済みなら自動でロック解除する
  // （supabase変数など、initが必要とする準備がすべて整った後にここで実行する）
  if (localStorage.getItem('mydrop_unlocked') === '1') {
    gate.style.display = 'none';
    app.style.display = 'block';
    init();
  }
})();
