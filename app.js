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
  function fileNameOf(path, fallback) {
    return (path || fallback).split('/').pop();
  }

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

    // ---------- プライベートモード（裏ページ） ----------
    // 状態はメモリ上だけに持つ（localStorage等には保存しない）。
    // → 再読み込み・タスキル後は必ず表ページから始まる。
    let isPrivate = false;
    let viewGen = 0; // モード切替のたびに増やし、切替前に始まった読み込み結果を捨てるために使う
    const PRIV_CODE = (typeof PRIVATE_CODE !== 'undefined') ? String(PRIVATE_CODE) : null;

    const appTitle = document.getElementById('appTitle');
    const privModal = document.getElementById('privModal');
    const privBox = document.getElementById('privBox');
    const privInput = document.getElementById('privInput');
    const privError = document.getElementById('privError');
    const privOk = document.getElementById('privOk');
    const privCancel = document.getElementById('privCancel');

    function openPrivModal() {
      privInput.value = '';
      privError.textContent = '';
      privModal.classList.add('open');
      setTimeout(() => privInput.focus(), 50);
    }
    function closePrivModal() {
      privModal.classList.remove('open');
      privInput.value = '';
      privInput.blur();
    }
    function tryPrivUnlock() {
      if (!PRIV_CODE) {
        privError.textContent = 'config.js に PRIVATE_CODE が未設定です';
        return;
      }
      if (privInput.value === PRIV_CODE) {
        closePrivModal();
        setMode(true);
      } else {
        privError.textContent = 'パスワードが違います';
        privInput.value = '';
        privBox.classList.remove('shake');
        void privBox.offsetWidth;
        privBox.classList.add('shake');
      }
    }

    function setMode(priv) {
      isPrivate = priv;
      viewGen++;
      document.body.classList.toggle('private-mode', priv);
      setSelectMode(false);
      // 入力途中の内容が別のページに送られないよう、切替時に入力欄をリセット
      textInput.value = '';
      autoGrow();
      pendingFiles = [];
      renderPreview();
      sendBtn.disabled = true;
      // 前のページの内容を即座に消してから読み込み直す
      items = [];
      list.innerHTML = '';
      document.getElementById('pinnedBar').style.display = 'none';
      emptyMsg.style.display = 'none';
      statusText.textContent = '読み込み中…';
      window.scrollTo(0, 0);
      refresh();
    }

    appTitle.addEventListener('click', () => {
      if (isPrivate) { setMode(false); return; } // 裏ページ中は、もう一度押すと表に戻る
      openPrivModal();
    });
    privOk.addEventListener('click', tryPrivUnlock);
    privCancel.addEventListener('click', closePrivModal);
    privInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); tryPrivUnlock(); }
      if (e.key === 'Escape') closePrivModal();
    });
    privModal.addEventListener('click', (e) => { if (e.target === privModal) closePrivModal(); });

    // 戻る/進むでページがキャッシュから復元された場合も表ページに戻す
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && isPrivate) setMode(false);
    });

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
    textInput.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData ? e.clipboardData.items : []);
      const files = items
        .filter(it => it.kind === 'file' && (it.type.startsWith('image/') || it.type.startsWith('video/')))
        .map(it => it.getAsFile())
        .filter(Boolean);
      if (files.length) {
        e.preventDefault(); // 画像などが含まれる場合は、テキストとしての貼り付けは行わない
        processIncomingFiles(files);
      }
    });

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      await processIncomingFiles(files);
      fileInput.value = '';
    });

    async function processIncomingFiles(files) {
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
    }

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
        const imgN = pendingFiles.filter(p => p.kind === 'image').length;
        count.textContent = imgN >= 2
          ? `${pendingFiles.length}件選択中（画像${imgN}枚は1つにまとめて送信されます）`
          : `${pendingFiles.length}件選択中`;
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
      const priv = isPrivate; // 送信開始時点のページに送る（途中で切り替えても混ざらない）
      const gen = viewGen;

      try {
        if (text) {
          statusText.textContent = '送信中…';
          const { error } = await supabase.from('drop_items').insert({ type: 'text', content: text, device: DEVICE, is_private: priv });
          if (error) {
            showError('テキストの送信に失敗しました', error);
          } else {
            if (gen === viewGen) { textInput.value = ''; autoGrow(); }
            statusText.textContent = '';
            await refresh();
          }
        }

        // 画像が2枚以上なら、LINEのように1つのまとまり（グループ）として送る
        const imageCount = files.filter(f => f.kind === 'image').length;
        const groupId = imageCount >= 2 ? uid() : null;
        const groupRows = []; // グループ分は全部アップロードしてから一括登録（途中の状態を見せないため）

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          statusText.textContent = files.length > 1 ? `送信中…（${i + 1}/${files.length}）` : '送信中…';
          const ext = f.kind === 'video' ? (f.name.split('.').pop() || 'mp4') : 'jpg';
          const path = (priv ? 'private/' : '') + `${uid()}.${ext}`;
          const contentType = f.kind === 'video' ? (f.blob.type || 'video/mp4') : 'image/jpeg';

          const { error: upErr } = await supabase.storage.from('drop-images').upload(path, f.blob, { contentType });
          if (upErr) {
            showError((f.kind === 'video' ? '動画' : '画像') + 'のアップロードに失敗しました', upErr);
            continue;
          }
          const row = { type: f.kind, image_path: path, device: DEVICE, is_private: priv };
          if (groupId && f.kind === 'image') {
            groupRows.push({ row, f });
            continue;
          }
          const { error: insErr } = await supabase.from('drop_items').insert(row);
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

        if (groupRows.length) {
          statusText.textContent = '登録中…';
          const rows = groupRows.map(g => Object.assign({}, g.row, {
            group_id: groupRows.length >= 2 ? groupId : null,
          }));
          const { error: insErr } = await supabase.from('drop_items').insert(rows);
          if (insErr) {
            const msg = String(insErr.message || '');
            if (msg.includes('group_id')) {
              statusText.textContent = 'まとめ送信には group_id 列が必要です（Supabaseで追加SQLを実行してください）';
              console.error('[MyDrop]', insErr);
            } else {
              showError('データベースへの登録に失敗しました', insErr);
            }
          } else {
            const sent = new Set(groupRows.map(g => g.f));
            pendingFiles = pendingFiles.filter(p => !sent.has(p));
            renderPreview();
            await refresh();
            statusText.textContent = '';
          }
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

    // よく使うテキストのピン留め／解除
    async function togglePin(it) {
      const { error } = await supabase.from('drop_items').update({ pinned: !it.pinned }).eq('id', it.id);
      if (error) { showError('ピン留めの更新に失敗しました', error); return; }
      await refresh();
    }

    function flashSuccess(el) {
      const prev = el.style.filter;
      el.style.filter = 'brightness(0.9)';
      setTimeout(() => { el.style.filter = prev || ''; }, 200);
    }

    // 画像データを取得する。既に読み込み済みの<img>があればcanvas経由（fetchのCORS問題を回避できるため優先）
    async function getBlobForItem(url, imgEl) {
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

    function renderPinned() {
      const bar = document.getElementById('pinnedBar');
      if (!bar) return;
      const pinned = items.filter(it => it.type === 'text' && it.pinned);
      bar.innerHTML = '';
      if (!pinned.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      pinned.forEach(it => {
        const chip = document.createElement('div');
        chip.className = 'pinned-chip';
        chip.title = it.content;
        const label = document.createElement('span');
        label.className = 'pinned-chip-label';
        label.textContent = it.content;
        chip.appendChild(label);
        chip.onclick = () => copyText(it.content, chip);
        const unpinBtn = document.createElement('span');
        unpinBtn.className = 'pinned-chip-x';
        unpinBtn.textContent = '×';
        unpinBtn.onclick = (e) => { e.stopPropagation(); togglePin(it); };
        chip.appendChild(unpinBtn);
        bar.appendChild(chip);
      });
    }

    // ---------- 複数選択モード ----------
    let selectMode = false;
    const selected = new Set();      // 選択中のアイテムid
    const unitEls = new Map();       // id → 選択マークを付ける要素
    const imgEls = new Map();        // id → 表示中の<img>（コピー時に再利用）
    const origBlobCache = new Map(); // id → Promise<Blob>（保存/共有用の元データ）
    const pngBlobCache = new Map();  // id → Promise<Blob>（クリップボード用PNG）

    const selectBtn = document.getElementById('selectBtn');
    const selectBar = document.getElementById('selectBar');
    const selCount = document.getElementById('selCount');
    const selCopy = document.getElementById('selCopy');
    const selShare = document.getElementById('selShare');
    const selDelete = document.getElementById('selDelete');
    const selCancel = document.getElementById('selCancel');

    // PCは小さいウィンドウで開くことが多く、画面下のバーが隠れやすいので、ヘッダーのすぐ下に移す
    if (DEVICE === 'pc') {
      document.body.classList.add('is-pc');
      const header = document.querySelector('#app .header');
      header.parentNode.insertBefore(selectBar, header.nextSibling);
    }

    function urlOf(it) {
      return supabase.storage.from('drop-images').getPublicUrl(it.image_path).data.publicUrl;
    }
    function isMedia(it) { return it.type === 'image' || it.type === 'video'; }

    function cachedPromise(cache, key, make) {
      if (cache.has(key)) return cache.get(key);
      const p = make();
      cache.set(key, p);
      p.catch(() => cache.delete(key)); // 失敗したら次回やり直せるようにする
      return p;
    }
    // 保存/共有用：元のJPEG/動画をそのまま取得（ダメならcanvas経由）
    function origBlob(it) {
      return cachedPromise(origBlobCache, it.id, async () => {
        const url = urlOf(it);
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('取得失敗 ' + res.status);
          return await res.blob();
        } catch (e) {
          if (it.type !== 'image') throw e;
          return await getBlobForItem(url, imgEls.get(it.id));
        }
      });
    }
    // コピー用：クリップボードはPNGしか受け付けないことが多いのでPNGに変換
    function pngBlob(it) {
      return cachedPromise(pngBlobCache, it.id, () => getBlobForItem(urlOf(it), imgEls.get(it.id)));
    }

    function setSelectMode(on) {
      selectMode = on;
      selected.clear();
      document.body.classList.toggle('select-mode', on);
      selectBtn.textContent = on ? '完了' : '選択';
      updateSelectUI();
    }
    function toggleSelect(it) {
      if (selected.has(it.id)) selected.delete(it.id);
      else {
        selected.add(it.id);
        if (isMedia(it)) origBlob(it).catch(() => {}); // 押した瞬間に裏で先読みしておく
      }
      updateSelectUI();
    }
    function updateSelectUI() {
      unitEls.forEach((el, id) => el.classList.toggle('selected', selected.has(id)));
      const n = selected.size;
      selCount.textContent = n ? `${n}件選択中` : 'タップして選択';
      selCopy.disabled = selShare.disabled = selDelete.disabled = n === 0;
    }
    function selectedItems() {
      // 画面の並び（新しい順）ではなく、送った順（古い順）で扱う
      return items.filter(it => selected.has(it.id)).reverse();
    }

    selectBtn.addEventListener('click', () => setSelectMode(!selectMode));
    selCancel.addEventListener('click', () => setSelectMode(false));
    selCopy.addEventListener('click', () => copyItems(selectedItems(), selCopy));
    selShare.addEventListener('click', () => shareItems(selectedItems()));
    selDelete.addEventListener('click', async () => {
      const ok = await deleteItems(selectedItems());
      if (ok) setSelectMode(false);
    });

    function flashStatus(msg, ms) {
      statusText.textContent = msg;
      setTimeout(() => { if (statusText.textContent === msg) statusText.textContent = ''; }, ms || 1500);
    }

    // まとめてコピー
    function copyItems(list, feedbackEl) {
      const imgs = list.filter(it => it.type === 'image');
      const texts = list.filter(it => it.type === 'text');
      if (!imgs.length) {
        if (texts.length) copyText(texts.map(t => t.content).join('\n'), feedbackEl);
        return;
      }
      if (imgs.length === 1) {
        copyImage(urlOf(imgs[0]), imgEls.get(imgs[0].id), feedbackEl);
        return;
      }
      if (!(navigator.clipboard && window.ClipboardItem)) {
        flashStatus('このブラウザは画像のコピーに非対応です。「保存/共有」を使ってください', 3500);
        return;
      }
      // iOS Safari対策：タップした瞬間に同期でclipboard.writeを呼ぶ（データはPromiseで渡す）
      try {
        const clipItems = imgs.map(it => new ClipboardItem({ 'image/png': pngBlob(it) }));
        navigator.clipboard.write(clipItems).then(() => {
          flashStatus(`${imgs.length}枚コピーしました`);
          if (feedbackEl) flashSuccess(feedbackEl);
        }).catch((err) => {
          console.error('[MyDrop] multi copy failed', err);
          flashStatus('このブラウザは複数枚の同時コピーに非対応です。「保存/共有」から送ってください', 4000);
        });
      } catch (err) {
        console.error('[MyDrop] multi copy error', err);
        flashStatus('このブラウザは複数枚の同時コピーに非対応です。「保存/共有」から送ってください', 4000);
      }
    }

    // まとめて保存/共有：スマホは共有シート（LINEに直接送る・写真に一括保存ができる）、PCはまとめてダウンロード
    async function shareItems(list) {
      const media = list.filter(isMedia);
      if (!media.length) { flashStatus('画像・動画が選ばれていません'); return; }
      statusText.textContent = `準備中…（${media.length}件）`;
      let blobs;
      try {
        blobs = await Promise.all(media.map(origBlob));
      } catch (err) {
        showError('データの取得に失敗しました', err);
        return;
      }
      const files = blobs.map((b, i) => {
        const it = media[i];
        let name = fileNameOf(it.image_path, it.type === 'video' ? 'drop.mp4' : 'drop.jpg');
        if (b.type === 'image/png') name = name.replace(/\.\w+$/, '.png');
        const type = b.type || (it.type === 'video' ? 'video/mp4' : 'image/jpeg');
        return new File([b], name, { type });
      });
      try {
        if (navigator.canShare && navigator.canShare({ files })) {
          await navigator.share({ files });
          statusText.textContent = '';
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') { statusText.textContent = ''; return; }
        if (err && err.name === 'NotAllowedError') {
          // 読み込みに時間がかかり「タップ直後」扱いが切れた場合。データは準備済みなので2回目はすぐ開く
          flashStatus('準備できました。もう一度「保存/共有」を押してください', 5000);
          return;
        }
        console.error('[MyDrop] share failed', err);
      }
      // 共有が使えない環境（主にPC）：1件ずつダウンロード
      for (const file of files) {
        const blobUrl = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        await sleep(350);
      }
      flashStatus(`${files.length}件ダウンロードしました`);
    }

    async function deleteItems(list) {
      if (!list.length) return false;
      if (!confirm(`${list.length}件を削除しますか？`)) return false;
      const { error } = await supabase.from('drop_items').delete().in('id', list.map(it => it.id));
      if (error) { showError('削除に失敗しました', error); return false; }
      const paths = list.filter(it => isMedia(it) && it.image_path).map(it => it.image_path);
      if (paths.length) await supabase.storage.from('drop-images').remove(paths);
      await refresh();
      return true;
    }

    // 選択モード中はタップで選択、通常時は元の動作
    function makeSelectable(el, it, normalClick) {
      el.classList.add('sel-unit');
      const mark = document.createElement('span');
      mark.className = 'sel-check';
      el.appendChild(mark);
      el.onclick = (e) => {
        if (selectMode) { e.stopPropagation(); toggleSelect(it); return; }
        if (normalClick) normalClick(e);
      };
      unitEls.set(it.id, el);
    }

    function render() {
      list.innerHTML = '';
      unitEls.clear();
      imgEls.clear();
      renderPinned();
      emptyMsg.style.display = items.length === 0 ? 'block' : 'none';

      // 消えたアイテムは選択から外す
      const ids = new Set(items.map(it => it.id));
      [...selected].forEach(id => { if (!ids.has(id)) selected.delete(id); });

      const doneGroups = new Set();
      items.forEach(it => {
        if (it.group_id && it.type === 'image') {
          if (doneGroups.has(it.group_id)) return;
          doneGroups.add(it.group_id);
          // 一括登録なので created_at は同じになる → ファイル名（先頭がアップロード時刻）で送った順に並べる
          const members = items.filter(x => x.group_id === it.group_id && x.type === 'image')
            .sort((a, b) => fileNameOf(a.image_path, '').localeCompare(fileNameOf(b.image_path, '')));
          if (members.length >= 2) { renderGroupRow(it, members); return; }
        }
        renderSingleRow(it);
      });
      updateSelectUI();
    }

    function makeRow(it) {
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
      return { row, content, actionsSide };
    }
    function sideBtn(parent, label, onClick, cls) {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = (e) => { e.stopPropagation(); onClick(b); };
      parent.appendChild(b);
      return b;
    }

    // LINE風：2列で並べたまとめ画像
    function renderGroupRow(first, members) {
      const { row, content, actionsSide } = makeRow(first);
      const grid = document.createElement('div');
      grid.className = 'bubble-group';
      members.forEach((it, idx) => {
        const url = urlOf(it);
        const tile = document.createElement('div');
        tile.className = 'tile';
        // 奇数枚のときは先頭1枚を横長にして、残りを2列できれいに揃える
        if (members.length % 2 === 1 && idx === 0) tile.classList.add('wide');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.crossOrigin = 'anonymous';
        img.src = url;
        tile.appendChild(img);
        imgEls.set(it.id, img);
        makeSelectable(tile, it, () => openLightbox(url, img, fileNameOf(it.image_path, 'drop.jpg')));
        grid.appendChild(tile);
      });
      const count = document.createElement('div');
      count.className = 'group-count';
      count.textContent = `${members.length}枚`;
      grid.appendChild(count);
      content.appendChild(grid);

      sideBtn(actionsSide, 'コピー', (b) => copyItems(members, b));
      sideBtn(actionsSide, '保存', () => shareItems(members));
      sideBtn(actionsSide, '削除', () => deleteItems(members), 'del');

      row.appendChild(actionsSide);
      row.appendChild(content);
      list.appendChild(row);
    }

    function renderSingleRow(it) {
      const { row, content, actionsSide } = makeRow(it);

      if (it.type === 'text') {
        const t = document.createElement('div');
        t.className = 'bubble-text';
        t.textContent = it.content;
        makeSelectable(t, it, () => copyText(it.content, t));
        content.appendChild(t);
        sideBtn(actionsSide, 'コピー', (b) => copyText(it.content, b));
        sideBtn(actionsSide, it.pinned ? 'ピン解除' : 'ピン留め', () => togglePin(it));
      } else if (it.type === 'video') {
        const url = urlOf(it);
        const bubble = document.createElement('div');
        bubble.className = 'bubble-image';
        bubble.style.cursor = 'default';
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.style.width = '100%';
        video.style.display = 'block';
        bubble.appendChild(video);
        makeSelectable(bubble, it, null);
        content.appendChild(bubble);
        sideBtn(actionsSide, '保存', () => shareOrDownload(url, fileNameOf(it.image_path, 'drop.mp4'), null));
      } else {
        const url = urlOf(it);
        const bubble = document.createElement('div');
        bubble.className = 'bubble-image';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.crossOrigin = 'anonymous';
        img.src = url;
        bubble.appendChild(img);
        imgEls.set(it.id, img);
        makeSelectable(bubble, it, () => openLightbox(url, img, fileNameOf(it.image_path, 'drop.jpg')));
        content.appendChild(bubble);
        sideBtn(actionsSide, 'コピー', (b) => copyImage(url, img, b));
        sideBtn(actionsSide, '保存', () => shareOrDownload(url, fileNameOf(it.image_path, 'drop.jpg'), img));
      }

      sideBtn(actionsSide, '削除', () => deleteItem(it), 'del');
      row.appendChild(actionsSide);
      row.appendChild(content);
      list.appendChild(row);
    }

    async function refresh() {
      const gen = viewGen;
      const priv = isPrivate;
      try {
        const { data, error } = await supabase
          .from('drop_items')
          .select('*')
          .eq('is_private', priv)
          .order('created_at', { ascending: false })
          .limit(200);
        if (gen !== viewGen) return; // 読み込み中にページが切り替わった場合は結果を捨てる
        if (error) {
          showError('読み込みに失敗しました', error);
          return;
        }
        items = data || [];
        render();
        if (statusText.textContent === '読み込み中…') statusText.textContent = '';
      } catch (e) {
        if (gen !== viewGen) return;
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
