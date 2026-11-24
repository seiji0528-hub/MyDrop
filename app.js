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

    // ---------- 裏ページの高画質写真（Cloudflare R2） ----------
    // config.js に R2_WORKER_URL があれば有効。パスワードはWorker側で確認し、メモリ上だけに持つ
    const R2_URL = (typeof R2_WORKER_URL !== 'undefined' && R2_WORKER_URL)
      ? String(R2_WORKER_URL).replace(/\/+$/, '') : null;
    let privCode = null; // 裏ページを開いたときに入力したパスワード（Worker認証用）
    const R2_FREE_BYTES = 10e9;  // 無料枠 10GB
    const R2_WARN_BYTES = 9e9;   // 9GBを超えたら警告
    const MAX_HQ_MB = 30;        // 高画質写真1枚あたりの上限

    function hqEnabled() { return isPrivate && !!R2_URL && !!privCode; }
    function isR2(it) { return !!(it.image_path && it.image_path.startsWith('r2/')); }
    function r2Key(it) { return it.image_path.slice(3); }
    function r2FileUrl(key) {
      return `${R2_URL}/file/${key}?t=${encodeURIComponent(privCode || '')}`;
    }
    async function r2Put(key, blob, type) {
      const res = await fetch(`${R2_URL}/file/${key}`, {
        method: 'PUT', headers: { 'X-Code': privCode, 'Content-Type': type || blob.type || 'application/octet-stream' }, body: blob,
      });
      if (!res.ok) throw new Error('高画質ストレージへの保存に失敗しました（' + res.status + '）');
    }
    async function r2Delete(keys) {
      for (const key of keys) {
        try { await fetch(`${R2_URL}/file/${key}`, { method: 'DELETE', headers: { 'X-Code': privCode } }); }
        catch (e) { console.error('[MyDrop] r2 delete failed', key, e); }
      }
    }
    function extOfImage(file) {
      const fromType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
        'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' }[file.type];
      if (fromType) return fromType;
      const e = (file.name || '').split('.').pop().toLowerCase();
      return /^(jpe?g|png|webp|gif|heic|heif|avif)$/.test(e) ? e.replace('jpeg', 'jpg') : 'jpg';
    }

    // 使用量の表示と、10GBに近づいたときの警告
    const r2Usage = document.getElementById('r2Usage');
    function showR2Usage(u) {
      if (!r2Usage) return;
      if (!u || !isPrivate) { r2Usage.style.display = 'none'; return; }
      const gb = (u.bytes / 1e9).toFixed(2);
      r2Usage.style.display = 'block';
      r2Usage.classList.toggle('warn', u.bytes >= R2_WARN_BYTES);
      if (u.bytes >= R2_FREE_BYTES) {
        r2Usage.textContent = `高画質写真の保存容量が ${gb}GB になり、無料枠の10GBを超えています。超えた分は1GBあたり月2円ほどかかります（支払い方法は登録済み）。無料のまま使いたい場合は、前の写真を消してください。`;
      } else if (u.bytes >= R2_WARN_BYTES) {
        r2Usage.textContent = `高画質写真の保存容量が ${gb}GB / 10GB で、無料枠に近づいています。10GBを超えると、超えた分は1GBあたり月2円ほどかかります（支払い方法は登録済み）。無料のまま使いたい場合は、前の写真を消してください。`;
      } else {
        r2Usage.textContent = `高画質保存：${gb}GB / 10GB`;
      }
    }
    async function checkR2Usage() {
      if (!hqEnabled()) { showR2Usage(null); return; }
      try {
        const res = await fetch(`${R2_URL}/usage`, { headers: { 'X-Code': privCode } });
        if (res.ok && isPrivate) showR2Usage(await res.json());
      } catch (e) { console.error('[MyDrop] usage check failed', e); }
    }

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
    function wrongPrivCode() {
      privError.textContent = 'パスワードが違います';
      privInput.value = '';
      privBox.classList.remove('shake');
      void privBox.offsetWidth;
      privBox.classList.add('shake');
    }
    async function tryPrivUnlock() {
      const typed = privInput.value;
      if (!typed) return;
      if (R2_URL) {
        // 高画質ストレージ（Worker）にパスワードを確認してもらう
        privOk.disabled = true;
        privError.textContent = '確認中…';
        try {
          const res = await fetch(`${R2_URL}/usage`, { headers: { 'X-Code': typed } });
          if (res.ok) {
            const u = await res.json();
            privCode = typed;
            closePrivModal();
            setMode(true);
            showR2Usage(u);
            return;
          }
          if (res.status === 401) { wrongPrivCode(); return; }
          throw new Error('status ' + res.status);
        } catch (err) {
          console.error('[MyDrop] worker unlock failed', err);
          // Workerにつながらない場合：config.jsのパスワードで開けるが、高画質保存は使えない
          if (PRIV_CODE && typed === PRIV_CODE) {
            privCode = null;
            closePrivModal();
            setMode(true);
            statusText.textContent = '高画質ストレージに接続できないため、今は通常画質で保存されます';
            return;
          }
          privError.textContent = '高画質ストレージに接続できません';
        } finally {
          privOk.disabled = false;
        }
        return;
      }
      if (!PRIV_CODE) {
        privError.textContent = 'config.js に PRIVATE_CODE が未設定です';
        return;
      }
      if (typed === PRIV_CODE) {
        closePrivModal();
        setMode(true);
      } else {
        wrongPrivCode();
      }
    }

    function setMode(priv) {
      isPrivate = priv;
      viewGen++;
      document.body.classList.toggle('private-mode', priv);
      setSelectMode(false);
      if (!priv) { privCode = null; showR2Usage(null); }
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
            if (hqEnabled()) {
              // 裏ページ：元画像をそのまま保存し、一覧用に小さいサムネイルだけ作る
              const sizeMB = file.size / (1024 * 1024);
              if (sizeMB > MAX_HQ_MB) {
                statusText.textContent = `「${file.name}」は${sizeMB.toFixed(1)}MBあり、上限${MAX_HQ_MB}MBを超えています（スキップしました）`;
                await sleep(1500);
              } else {
                const thumb = await compressImage(file, 640, 0.8);
                pendingFiles.push({ kind: 'image', hq: true, blob: file, thumb: thumb.blob, dataUrl: thumb.dataUrl, name: file.name });
              }
            } else {
              const { blob, dataUrl } = await compressImage(file);
              pendingFiles.push({ kind: 'image', blob, dataUrl, name: file.name });
            }
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

    function compressImage(file, maxDimArg, qualityArg) {
      const maxDim = maxDimArg || 1600;
      const quality = qualityArg || 0.85;
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
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
              const dataUrl = canvas.toDataURL('image/jpeg', quality);
              resolve({ blob, dataUrl });
            }, 'image/jpeg', quality);
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
        let usedR2 = false;

        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          statusText.textContent = files.length > 1 ? `送信中…（${i + 1}/${files.length}）` : '送信中…';
          let path;
          if (f.hq) {
            // 高画質：元画像とサムネイルをCloudflare R2へ
            const id = uid();
            const key = `${id}.${extOfImage(f.blob)}`;
            try {
              await r2Put(`thumb/${id}.jpg`, f.thumb, 'image/jpeg');
              await r2Put(key, f.blob, f.blob.type);
            } catch (err) {
              showError('画像のアップロードに失敗しました', err);
              continue;
            }
            path = 'r2/' + key;
            usedR2 = true;
          } else {
            const ext = f.kind === 'video' ? (f.name.split('.').pop() || 'mp4') : 'jpg';
            path = (priv ? 'private/' : '') + `${uid()}.${ext}`;
            const contentType = f.kind === 'video' ? (f.blob.type || 'video/mp4') : 'image/jpeg';

            const { error: upErr } = await supabase.storage.from('drop-images').upload(path, f.blob, { contentType });
            if (upErr) {
              showError((f.kind === 'video' ? '動画' : '画像') + 'のアップロードに失敗しました', upErr);
              continue;
            }
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
        if (usedR2) checkR2Usage();
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
        if (isR2(it)) { await r2Delete([r2Key(it)]); checkR2Usage(); }
        else await supabase.storage.from('drop-images').remove([it.image_path]);
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
        if (imgEl) blob = await getBlobForItem(url, imgEl);
        else {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('取得失敗 ' + res.status);
            blob = await res.blob();
          } catch (e) { blob = await getBlobForItem(url, null); }
        }
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
    // ---------- 写真ビューアー ----------
    // ・左右スワイプ（PCは ← → キー／画面の ‹ › ／タッチパッドの横スワイプ）で前後の写真へ
    // ・ピンチ（PCはスクロール／タッチパッドのピンチ）で、指やカーソルの位置を中心に拡大縮小
    // ・ダブルタップで拡大／元に戻す、下にスワイプで閉じる
    let galleryUnits = []; // 画面の並び順（新しい順）で、1件 or まとめ画像の配列を入れる。render()で作る

    function galleryEntry(it, srcImg) {
      return {
        id: it.id,
        url: urlOf(it),
        thumb: thumbUrlOf(it),
        srcImg,
        filename: fileNameOf(it.image_path, 'drop.jpg'),
      };
    }

    function openLightbox(startId) {
      // 送った順（古い→新しい）に並べる。まとめ画像の中は左上から順
      const gallery = galleryUnits.slice().reverse().flat();
      if (!gallery.length) return;
      let index = Math.max(0, gallery.findIndex(g => g.id === startId));

      const MIN_SCALE = 1, MAX_SCALE = 6;

      const overlay = document.createElement('div');
      overlay.className = 'lb-overlay';
      const stage = document.createElement('div');
      stage.className = 'lb-stage';
      const img = document.createElement('img');
      img.className = 'lb-img';
      img.draggable = false;
      img.alt = '';
      stage.appendChild(img);
      overlay.appendChild(stage);

      // 上部：枚数表示とボタン
      const topBar = document.createElement('div');
      topBar.className = 'lb-top';
      const counter = document.createElement('div');
      counter.className = 'lb-counter';
      const tools = document.createElement('div');
      tools.className = 'lb-tools';
      function mkBtn(label, cls) {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = cls || 'lb-btn';
        return b;
      }
      const copyBtn = mkBtn('コピー');
      const saveBtn = mkBtn('保存');
      const closeBtn = mkBtn('閉じる');
      tools.append(copyBtn, saveBtn, closeBtn);
      topBar.append(counter, tools);
      overlay.appendChild(topBar);

      const prevBtn = mkBtn('‹', 'lb-nav lb-prev');
      const nextBtn = mkBtn('›', 'lb-nav lb-next');
      overlay.append(prevBtn, nextBtn);

      const hint = document.createElement('div');
      hint.className = 'lb-hint';
      hint.textContent = DEVICE === 'pc'
        ? '← → キーで前後の写真　スクロール／タッチパッドのピンチで拡大　Escで閉じる'
        : '左右スワイプで前後の写真　ピンチ・ダブルタップで拡大　下にスワイプで閉じる';
      overlay.appendChild(hint);
      setTimeout(() => hint.classList.add('fade'), 2500);

      // ---- 表示状態 ----
      let scale = 1, tx = 0, ty = 0;
      function apply(animate) {
        img.style.transition = animate ? 'transform 0.22s ease-out' : 'none';
        img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      }
      function stageCenter() {
        const r = stage.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }
      // 画像がはみ出しすぎないよう、移動できる範囲に収める
      function clampPan() {
        const c = stageCenter();
        const maxX = Math.max(0, (img.offsetWidth * scale - c.w) / 2);
        const maxY = Math.max(0, (img.offsetHeight * scale - c.h) / 2);
        tx = Math.min(maxX, Math.max(-maxX, tx));
        ty = Math.min(maxY, Math.max(-maxY, ty));
      }
      // 画面上の点(px,py)を中心にして拡大率を変える
      function zoomAt(px, py, newScale, animate) {
        const c = stageCenter();
        const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
        const ox = px - c.x, oy = py - c.y;
        tx = ox - (ox - tx) * (ns / scale);
        ty = oy - (oy - ty) * (ns / scale);
        scale = ns;
        if (scale <= 1.001) { scale = 1; tx = 0; ty = 0; }
        clampPan();
        apply(animate);
      }
      function resetZoom(animate) { scale = 1; tx = 0; ty = 0; apply(animate); }

      // ---- 写真の切り替え ----
      function current() { return gallery[index]; }
      function preload(i) {
        const g = gallery[i];
        if (g) { const p = new Image(); p.src = g.url; }
      }
      function showCurrent() {
        const g = current();
        counter.textContent = gallery.length > 1 ? `${index + 1} / ${gallery.length}` : '';
        prevBtn.style.visibility = index > 0 ? 'visible' : 'hidden';
        nextBtn.style.visibility = index < gallery.length - 1 ? 'visible' : 'hidden';
        // 高画質写真は、まずサムネイルを出してすぐ表示し、元画像が読み込めたら差し替える
        img.src = g.thumb;
        if (g.url !== g.thumb) {
          const full = new Image();
          full.onload = () => { if (current() === g) img.src = g.url; };
          full.src = g.url;
        }
        preload(index + 1);
        preload(index - 1);
      }
      let sliding = false;
      function go(dir) {
        const ni = index + dir;
        if (sliding) return;
        if (ni < 0 || ni >= gallery.length) { resetZoom(true); return; }
        sliding = true;
        const w = stageCenter().w;
        scale = 1; ty = 0;
        tx = -dir * w;               // 今の写真を外へ
        apply(true);
        setTimeout(() => {
          index = ni;
          showCurrent();
          tx = dir * w;              // 反対側から
          apply(false);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            tx = 0;
            apply(true);
            setTimeout(() => { sliding = false; }, 230);
          }));
        }, 180);
      }

      // ---- タッチ／マウス操作 ----
      const pointers = new Map();
      let gesture = null; // 'pan' | 'swipe-x' | 'swipe-y' | 'pinch' | null
      let start = null;   // 操作開始時の状態
      let pinchStart = null;
      let lastTap = { t: 0, x: 0, y: 0 };
      let moved = false;

      function mid() {
        const p = [...pointers.values()];
        return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
      }
      function beginSingle(e) {
        start = { x: e.clientX, y: e.clientY, tx, ty, t: performance.now() };
        gesture = scale > 1.01 ? 'pan' : null;
      }

      stage.addEventListener('pointerdown', (e) => {
        if (sliding) return;
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 一部ブラウザでは失敗しても問題なし */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          moved = false;
          beginSingle(e);
        } else if (pointers.size === 2) {
          const m = mid();
          const c = stageCenter();
          gesture = 'pinch';
          pinchStart = { d: m.d, scale, tx, ty, mx: m.x - c.x, my: m.y - c.y };
          moved = true;
        }
      });

      stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (gesture === 'pinch' && pointers.size >= 2) {
          const m = mid();
          const c = stageCenter();
          // 少しだけ1倍未満まで縮められる（離すと戻る）ので、縮小の動きが途中で止まらない
          const ns = Math.min(MAX_SCALE, Math.max(0.7, pinchStart.scale * (m.d / pinchStart.d)));
          const ox = m.x - c.x, oy = m.y - c.y;
          tx = ox - (pinchStart.mx - pinchStart.tx) * (ns / pinchStart.scale);
          ty = oy - (pinchStart.my - pinchStart.ty) * (ns / pinchStart.scale);
          scale = ns;
          apply(false);
          return;
        }
        if (pointers.size !== 1 || !start) return;

        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;

        if (gesture === 'pan') {
          tx = start.tx + dx; ty = start.ty + dy;
          apply(false);
          return;
        }
        if (!gesture && moved) {
          gesture = Math.abs(dx) >= Math.abs(dy) ? 'swipe-x' : (dy > 0 ? 'swipe-y' : null);
        }
        if (gesture === 'swipe-x') {
          // 端の写真ではゴムのように少しだけ動く
          const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === gallery.length - 1);
          tx = atEdge ? dx * 0.3 : dx;
          apply(false);
        } else if (gesture === 'swipe-y') {
          ty = Math.max(0, dy);
          apply(false);
          overlay.style.backgroundColor = `rgba(0,0,0,${Math.max(0.35, 0.94 - ty / 500)})`;
        }
      });

      function endPointer(e) {
        if (!pointers.has(e.pointerId)) return;
        const wasPinch = gesture === 'pinch';
        pointers.delete(e.pointerId);

        if (wasPinch) {
          if (pointers.size === 1) {
            // 2本→1本になったら、残った指でそのまま移動できるようにする
            const p = [...pointers.values()][0];
            start = { x: p.x, y: p.y, tx, ty, t: performance.now() };
            gesture = scale > 1.01 ? 'pan' : 'done';
            return;
          }
          if (pointers.size === 0) {
            gesture = null;
            if (scale < 1) resetZoom(true);
            else { clampPan(); apply(true); }
          }
          return;
        }
        if (pointers.size > 0 || !start) return;

        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        const dt = Math.max(1, performance.now() - start.t);

        if (gesture === 'pan' || gesture === 'done') {
          // ピンチの指を1本ずつ離した場合もここに来る。縮めすぎていたら元の大きさに戻す
          if (scale < 1.01) resetZoom(true);
          else { clampPan(); apply(true); }
        } else if (gesture === 'swipe-x') {
          const w = stageCenter().w;
          const fast = Math.abs(dx) / dt > 0.45 && Math.abs(dx) > 30;
          if (Math.abs(dx) > Math.min(90, w * 0.2) || fast) go(dx < 0 ? 1 : -1);
          else resetZoom(true);
        } else if (gesture === 'swipe-y') {
          if (dy > 110 || (dy / dt > 0.5 && dy > 40)) { close(); return; }
          overlay.style.backgroundColor = '';
          resetZoom(true);
        } else if (!moved && gesture !== 'done') {
          // タップ：ダブルタップで拡大／元に戻す。写真の外を1回タップで閉じる
          const now = performance.now();
          const dbl = now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
          if (dbl) {
            lastTap.t = 0;
            if (scale > 1.01) resetZoom(true);
            else zoomAt(e.clientX, e.clientY, 2.5, true);
          } else {
            lastTap = { t: now, x: e.clientX, y: e.clientY };
            if (e.target === stage && scale <= 1.01) {
              setTimeout(() => { if (lastTap.t === now) close(); }, 300);
            }
          }
        }
        gesture = null;
        start = null;
      }
      stage.addEventListener('pointerup', endPointer);
      stage.addEventListener('pointercancel', endPointer);

      // PC：ホイール／タッチパッド
      let wheelX = 0, wheelLock = 0;
      overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
        const dx = e.deltaX * unit, dy = e.deltaY * unit;
        // タッチパッドの2本指の横スワイプ（拡大していない時）→ 前後の写真
        if (!e.ctrlKey && scale <= 1.01 && Math.abs(dx) > Math.abs(dy)) {
          if (performance.now() < wheelLock) return;
          wheelX += dx;
          if (Math.abs(wheelX) > 80) {
            go(wheelX > 0 ? 1 : -1);
            wheelX = 0;
            wheelLock = performance.now() + 450;
          }
          return;
        }
        wheelX = 0;
        // 拡大中の2本指移動（タッチパッド）は写真の移動
        if (!e.ctrlKey && scale > 1.01 && Math.abs(dx) > 0.5 && Math.abs(dx) >= Math.abs(dy) * 0.5) {
          tx -= dx; ty -= dy;
          clampPan(); apply(false);
          return;
        }
        // タッチパッドのピンチは ctrlKey 付きの小さな値で来るので、強めに効かせる
        const k = e.ctrlKey ? 0.012 : 0.0025;
        const d = Math.max(-60, Math.min(60, dy));
        zoomAt(e.clientX, e.clientY, scale * Math.exp(-d * k), false);
      }, { passive: false });

      function onKey(e) {
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowRight') go(1);
        else if (e.key === 'ArrowLeft') go(-1);
        else if (e.key === '+' || e.key === '=') { const c = stageCenter(); zoomAt(c.x, c.y, scale * 1.4, true); }
        else if (e.key === '-') { const c = stageCenter(); zoomAt(c.x, c.y, scale / 1.4, true); }
        else if (e.key === '0') resetZoom(true);
        else return;
        e.preventDefault();
      }
      document.addEventListener('keydown', onKey);

      function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
      }

      prevBtn.onclick = (e) => { e.stopPropagation(); go(-1); };
      nextBtn.onclick = (e) => { e.stopPropagation(); go(1); };
      closeBtn.onclick = close;
      copyBtn.onclick = () => { const g = current(); copyImage(g.url, g.srcImg, copyBtn); };
      saveBtn.onclick = () => { const g = current(); shareOrDownload(g.url, g.filename, g.srcImg); };

      document.body.appendChild(overlay);
      showCurrent();
      apply(false);
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
      if (isR2(it)) return r2FileUrl(r2Key(it));
      return supabase.storage.from('drop-images').getPublicUrl(it.image_path).data.publicUrl;
    }
    // 一覧表示用（高画質写真はサムネイル、それ以外は元と同じ）
    function thumbUrlOf(it) {
      if (isR2(it)) return r2FileUrl('thumb/' + r2Key(it).replace(/\.\w+$/, '.jpg'));
      return urlOf(it);
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
      const media = list.filter(it => isMedia(it) && it.image_path);
      const paths = media.filter(it => !isR2(it)).map(it => it.image_path);
      if (paths.length) await supabase.storage.from('drop-images').remove(paths);
      const r2Keys = media.filter(isR2).map(r2Key);
      if (r2Keys.length) { await r2Delete(r2Keys); checkR2Usage(); }
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
      galleryUnits = [];
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
      const unit = [];
      galleryUnits.push(unit);
      members.forEach((it, idx) => {
        const url = urlOf(it);
        const tile = document.createElement('div');
        tile.className = 'tile';
        // 奇数枚のときは先頭1枚を横長にして、残りを2列できれいに揃える
        if (members.length % 2 === 1 && idx === 0) tile.classList.add('wide');
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.crossOrigin = 'anonymous';
        img.src = thumbUrlOf(it);
        tile.appendChild(img);
        // 高画質写真の<img>は小さいサムネイルなので、コピー・保存には使わない（元画像を取りに行く）
        const srcImg = isR2(it) ? null : img;
        if (srcImg) imgEls.set(it.id, img);
        makeSelectable(tile, it, () => openLightbox(it.id));
        unit.push(galleryEntry(it, srcImg));
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
        img.src = thumbUrlOf(it);
        bubble.appendChild(img);
        const srcImg = isR2(it) ? null : img;
        if (srcImg) imgEls.set(it.id, img);
        makeSelectable(bubble, it, () => openLightbox(it.id));
        galleryUnits.push([galleryEntry(it, srcImg)]);
        content.appendChild(bubble);
        sideBtn(actionsSide, 'コピー', (b) => copyImage(url, srcImg, b));
        sideBtn(actionsSide, '保存', () => shareOrDownload(url, fileNameOf(it.image_path, 'drop.jpg'), srcImg));
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
