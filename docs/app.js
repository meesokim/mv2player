// app.js: initialize UI when Emscripten Module runtime is ready
console.log('app.js loaded');

// Lightweight runtime debug logger. Enable by setting `localStorage.setItem('mv2_debug','1')`.
const MV2_DEBUG = (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem && window.localStorage.getItem('mv2_debug') === '1');
function dbg() { if (MV2_DEBUG) { try { console.log.apply(console, arguments); } catch(e) {} } }
function dbgWarn() { if (MV2_DEBUG) { try { console.warn.apply(console, arguments); } catch(e) {} } }
function dbgError() { if (MV2_DEBUG) { try { console.error.apply(console, arguments); } catch(e) {} } }

function initUI() {
	dbg('initUI');
	const l = document.getElementById('loading');
	if (l) l.textContent = 'Ready';
	const title = document.getElementById('title');
	if (title) title.textContent = 'MV2 Player';
}

if (typeof Module !== 'undefined') {
	try {
		if (Module.onRuntimeInitialized === undefined && !Module.calledRun) {
			Module.onRuntimeInitialized = function () {
				dbg('mv2 wasm runtime initialized (onRuntimeInitialized)');
				try { initUI(); } catch (e) { console.error('initUI error', e); }
				try { if (typeof setupDrop === 'function') { setupDrop(); } } catch (e) { console.error('setupDrop error', e); }
			};
		} else {
			// runtime already processed — initialize immediately
			dbg('Module already initialized or calledRun; running initUI/setupDrop immediately');
			try { initUI(); } catch (e) { console.error('initUI error', e); }
			try { if (typeof setupDrop === 'function') { setupDrop(); } } catch (e) { console.error('setupDrop error', e); }
		}
	} catch (e) {
		console.warn('Module.onRuntimeInitialized assignment failed, falling back', e);
		document.addEventListener('DOMContentLoaded', initUI);
	}
} else {
	document.addEventListener('DOMContentLoaded', initUI);
}

// --- drop & render logic ---
function setupDrop() {
	dbg('setupDrop');
	const drop = document.getElementById('dropzone');
	const canvas = document.getElementById('canvas');
	const controls = document.getElementById('controls');
	const loading = document.getElementById('loading');
	const playerArea = document.getElementById('player-area');
	if (!drop || !canvas) { console.warn('missing drop or canvas element', { drop: !!drop, canvas: !!canvas }); return; }

	// prevent clicks inside controls from bubbling up to player-area
	if (controls) {
		controls.addEventListener('click', e => { try { e.stopPropagation(); } catch(e) {} });
	}

	function renderRGBAtoCanvas(bufPtr, w, h) {
		try {
			dbg('renderRGBAtoCanvas', { bufPtr, w, h });
			const len = w * h * 4;
			const heap = Module.HEAPU8;
			const view = heap.subarray(bufPtr, bufPtr + len);
			const ctx = canvas.getContext('2d');
			if (!ctx) { console.error('no 2d context'); return; }
			canvas.width = w;
			canvas.height = h;
			const img = ctx.createImageData(w, h);
			img.data.set(view);
			ctx.putImageData(img, 0, 0);
			dbg('frame rendered');
		} catch (e) { console.error('render error', e); }
	}

	function processDropEvent(e) {
		try {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
			let file = null;
			if (e.dataTransfer.files && e.dataTransfer.files.length) file = e.dataTransfer.files[0];
			else if (e.dataTransfer.items && e.dataTransfer.items.length) {
				const it = e.dataTransfer.items[0];
				if (it && it.kind === 'file' && it.getAsFile) file = it.getAsFile();
			}
			if (file) {
				dbg('processDropEvent: got file', file.name || file.type || file.size);
				handleFile(file);
			}
		} catch (err) { console.warn('processDropEvent failed', err); }
	}
	function processDragOver(e) {
		try { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch(e) {}
	}

	// Safe wasm allocator helpers: try multiple exported names that builds may provide.
	function wasmAlloc(sz) {
		if (!sz || sz <= 0) return 0;
		if (typeof Module === 'undefined') return 0;
		if (Module._malloc) return Module._malloc(sz);
		if (Module._wasm_alloc) return Module._wasm_alloc(sz);
		if (Module.wasm_alloc) return Module.wasm_alloc(sz);
		if (Module.cwrap) {
			try {
				const alloc = Module.cwrap('wasm_alloc', 'number', ['number']);
				if (alloc) return alloc(sz);
			} catch(e){}
		}
		return 0;
	}
	function wasmFree(ptr) {
		if (!ptr) return;
		if (typeof Module === 'undefined') return;
		if (Module._free) try { Module._free(ptr); return; } catch(e){}
		if (Module._wasm_free) try { Module._wasm_free(ptr); return; } catch(e){}
		if (Module.wasm_free) try { Module.wasm_free(ptr); return; } catch(e){}
		if (Module.cwrap) {
			try {
				const fr = Module.cwrap('wasm_free', null, ['number']);
				if (fr) fr(ptr);
			} catch(e){}
		}
	}

	// playback state
	let playbackTimer = null; // legacy interval id (kept for compatibility)
	let rafId = null;
	let lastTick = 0;
	let isPlaying = false;
	let playbackSpeed = 1.0;

	function updatePlayButton(playing) {
		const btn = document.getElementById('play');
		if (!btn) return;
		btn.setAttribute('data-playing', playing ? '1' : '0');
		const icon = document.getElementById('play-icon');
		const text = document.getElementById('play-text');
		if (icon && text) {
			if (playing) {
				icon.style.display = 'none';
				text.style.display = 'inline-block';
				btn.setAttribute('aria-label','Pause');
			} else {
				icon.style.display = 'block';
				text.style.display = 'none';
				btn.setAttribute('aria-label','Play');
			}
		} else if (icon) {
			// fallback: visual opacity toggle
			icon.style.opacity = playing ? '0.6' : '1.0';
		}
	}

	// ensure initial canvas fills the player-area height so blank player looks correct
	function ensureInitialCanvasSize() {
		try {
			const pa = document.getElementById('player-area');
			if (canvas && pa) {
				canvas.style.height = '100%';
				canvas.style.width = 'auto';
				// remember as scaled size for fullscreen restore logic
				try { canvas.dataset.scaledWidth = canvas.style.width; canvas.dataset.scaledHeight = canvas.style.height; } catch(e) {}
			}
		} catch(e) { console.warn('ensureInitialCanvasSize failed', e); }
	}

	function updateControlsWidth() {
		try {
			const pa = document.getElementById('player-area');
			if (!pa || !controls) return;
			const target = Math.round(pa.clientWidth * 0.9);
			controls.style.width = target + 'px';
			controls.style.maxWidth = '90%';
		} catch(e) { console.warn('updateControlsWidth failed', e); }
	}

	// initialize sizes
	ensureInitialCanvasSize();
	updateControlsWidth();
	window.addEventListener('resize', () => { ensureInitialCanvasSize(); updateControlsWidth(); });

	// controls auto-hide after inactivity
	let controlsTimer = null;
	const CONTROLS_IDLE_MS = 5000;
	function showControls() {
		try {
			const pa = document.getElementById('player-area');
			if (!pa) return;
			pa.classList.add('controls-enabled');
			pa.classList.remove('controls-hidden');
			updateControlsWidth();
		} catch(e) { console.warn('showControls failed', e); }
	}
	function hideControls() {
		try {
			const pa = document.getElementById('player-area');
			if (!pa) return;
			pa.classList.remove('controls-enabled');
			pa.classList.add('controls-hidden');
		} catch(e) { console.warn('hideControls failed', e); }
	}
	function resetControlsTimer() {
		try {
			showControls();
			if (controlsTimer) { clearTimeout(controlsTimer); controlsTimer = null; }
			controlsTimer = setTimeout(() => { hideControls(); controlsTimer = null; }, CONTROLS_IDLE_MS);
		} catch(e) { console.warn('resetControlsTimer failed', e); }
	}

	// show controls on any pointer activity over player-area and hide after idle
	if (playerArea) {
		playerArea.addEventListener('mousemove', resetControlsTimer);
		playerArea.addEventListener('pointerdown', resetControlsTimer);
		playerArea.addEventListener('mouseenter', resetControlsTimer);
		playerArea.addEventListener('mouseleave', () => { try { if (controlsTimer) clearTimeout(controlsTimer); hideControls(); } catch(e){} });
		// initialize with controls visible for a short time
		resetControlsTimer();
	}

	function renderFrameIndex(idx) {
		try {
			if (!window.__currentMV2) return;
			idx = ((idx % window.__currentFrames) + window.__currentFrames) % window.__currentFrames;
			const ptr = Module._mv2_get_frame_rgba(window.__currentMV2, idx);
			if (ptr && window.__currentWidth > 0 && window.__currentHeight > 0) {
				renderRGBAtoCanvas(ptr, window.__currentWidth, window.__currentHeight);
				try { Module._mv2_free_buffer(ptr); } catch (e) { console.warn('free_buffer failed during renderFrame', e); }
			}
			window.__currentFrame = idx;
			// update seek UI
			const seekEl = document.getElementById('seek');
			if (seekEl && window.__currentFrames) seekEl.value = Math.min(window.__currentFrames - 1, Math.max(0, Math.floor(idx)));
			const timeEl = document.getElementById('time');
			if (timeEl) {
				const fps = window.__currentFPS || 15;
				const cur = (idx / fps) || 0;
				const total = (window.__currentFrames / fps) || 0;
				const fmt = t => Math.floor(t/60)+":"+String(Math.floor(t%60)).padStart(2,'0');
				timeEl.textContent = fmt(cur) + ' / ' + fmt(total);
			}
		} catch (e) { console.error('renderFrameIndex error', e); }
	}

	function rafLoop(ts) {
		try {
			if (!isPlaying) return;
			const fps = window.__currentFPS || 15;
			if (window.__currentAudio && !isNaN(window.__currentAudio.duration) && window.__currentAudio.duration > 0) {
				// use audio as master clock
				const audioTime = window.__currentAudio.currentTime || 0;
				const targetFrame = Math.floor(audioTime * fps);
				if (targetFrame !== window.__currentFrame) renderFrameIndex(targetFrame);
			} else {
				// no audio: advance based on elapsed time
				if (!lastTick) lastTick = ts;
				const elapsed = ts - lastTick;
				const effectiveFps = fps * playbackSpeed;
				const frameDuration = 1000 / effectiveFps;
				if (elapsed >= frameDuration) {
					const skip = Math.floor(elapsed / frameDuration);
					renderFrameIndex(window.__currentFrame + skip);
					lastTick = ts;
				}
			}
		} catch (e) { console.error('rafLoop error', e); }
		rafId = requestAnimationFrame(rafLoop);
	}

	function startPlayback() {
		try {
			stopPlayback();
			if (!window.__currentMV2 || !window.__currentFrames) return;
			// try to play audio if present
			try {
				if (window.__currentAudio) {
					// ensure playbackRate respects selected speed
					try { window.__currentAudio.playbackRate = playbackSpeed; } catch(e) {}
					const p = window.__currentAudio.play();
					if (p && p.catch) p.catch(err => console.warn('audio play blocked', err));
					const volEl = document.getElementById('volume');
					if (volEl) window.__currentAudio.volume = parseFloat(volEl.value);
				}
			} catch (e) { console.warn('audio resume failed', e); }
			isPlaying = true;
			lastTick = 0;
			rafId = requestAnimationFrame(rafLoop);
			updatePlayButton(true);
		} catch (e) { console.error('startPlayback error', e); }
	}

	function stopPlayback() {
		try {
			if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
			if (window.__currentAudio && !window.__currentAudio.paused) {
				try { window.__currentAudio.pause(); } catch (e) { /* ignore */ }
			}
		} finally {
			isPlaying = false;
			updatePlayButton(false);
		}
	}

	function togglePlay() { if (isPlaying) stopPlayback(); else startPlayback(); }

	// wire play button
	const playBtn = document.getElementById('play');
	if (playBtn) playBtn.addEventListener('click', (e) => { e.preventDefault(); togglePlay(); });

	// wire speed select control
	const speedSelect = document.getElementById('speedSelect');
	if (speedSelect) {
		speedSelect.addEventListener('change', e => {
			try {
				playbackSpeed = parseFloat(e.target.value) || 1.0;
				if (window.__currentAudio) {
					try { window.__currentAudio.playbackRate = playbackSpeed; } catch (err) { console.warn('set playbackRate failed', err); }
				}
			} catch (err) { console.warn('speedSelect handler failed', err); }
		});
	}

	// wire volume control to active audio
	const volEl = document.getElementById('volume');
	if (volEl) volEl.addEventListener('input', e => {
		try { if (window.__currentAudio) window.__currentAudio.volume = parseFloat(e.target.value); } catch (e) { console.warn('volume set failed', e); }
	});

	async function handleFile(file) {
		dbg('handleFile start', file && file.name, file && file.size);
		try {
			if (typeof Module === 'undefined') { console.error('Module undefined'); return; }
			const expectedFns = ['_mv2_create_from_memory','_mv2_get_width','_mv2_get_height','_mv2_get_num_frames','_mv2_get_frame_rgba','_mv2_free_buffer','_malloc','_free'];
			expectedFns.forEach(fn => { if (!Module[fn]) console.warn('missing export', fn); });

			if (loading) {
				loading.textContent = 'Loading...';
				loading.style.display = 'block';
			}
			const ab = await file.arrayBuffer();
			const u8 = new Uint8Array(ab);
			dbg('file bytes', u8.length);

			const ptr = Module._malloc(u8.length);
			dbg('malloc ptr', ptr);
			Module.HEAPU8.set(u8, ptr);

			let mv2 = 0;
			try {
				mv2 = Module._mv2_create_from_memory(ptr, u8.length);
			} catch (e) {
				console.error('mv2_create_from_memory threw', e);
			}
			try { Module._free(ptr); } catch (e) { console.warn('free failed', e); }

			dbg('mv2 handle', mv2);
			if (!mv2) { console.error('mv2 create failed'); if (loading) loading.textContent = 'Failed to load'; return; }

			let w = 0, h = 0, frames = 0;
			try { w = Module._mv2_get_width(mv2); } catch (e) { console.error('_mv2_get_width error', e); }
			try { h = Module._mv2_get_height(mv2); } catch (e) { console.error('_mv2_get_height error', e); }
			try { frames = Module._mv2_get_num_frames(mv2); } catch (e) { console.error('_mv2_get_num_frames error', e); }
			dbg('mv2 loaded', { w, h, frames });

			// scale canvas to fit player area while preserving aspect ratio
			try {
				const container = document.getElementById('player-area');
				if (container && canvas) {
					const maxW = Math.max(320, container.clientWidth - 20);
					// allow up to 6x scaling but never exceed container width
					const scale = Math.min(Math.max(1, Math.floor(maxW / w)), 6);
					canvas.style.width = Math.min(maxW, w * scale) + 'px';
					canvas.style.height = 'auto';
					// remember scaled CSS size so we can restore after fullscreen
					try { canvas.dataset.scaledWidth = canvas.style.width; canvas.dataset.scaledHeight = canvas.style.height || 'auto'; } catch(e) {}
					dbg('canvas scaled', { scale, displayW: w*scale });
					// adjust controls width to match new canvas/container size
					try { updateControlsWidth(); } catch(e) {}
				}
			} catch (e) { console.warn('canvas scale failed', e); }

			let framePtr = 0;
			try {
				framePtr = Module._mv2_get_frame_rgba(mv2, 0);
				dbg('framePtr', framePtr);
			} catch (e) { console.error('_mv2_get_frame_rgba error', e); }

			if (framePtr && w > 0 && h > 0) {
				renderRGBAtoCanvas(framePtr, w, h);
				try { Module._mv2_free_buffer(framePtr); } catch (e) { console.warn('free_buffer failed', e); }
				// first frame displayed — hide loading overlay
				try { if (loading) loading.style.display = 'none'; } catch(e) {}
				// update seek range and time display
				const seekEl = document.getElementById('seek');
				if (seekEl) {
					seekEl.max = Math.max(0, frames - 1);
					seekEl.value = 0;
				}
				const timeEl = document.getElementById('time');
				if (timeEl) {
					const totalSecs = (frames / (window.__currentFPS || 15)) || 0;
					const fmt = t => Math.floor(t/60)+":"+String(Math.floor(t%60)).padStart(2,'0');
					timeEl.textContent = '0:00 / ' + fmt(totalSecs);
				}
			} else {
				console.error('no frame available or invalid dimensions', { framePtr, w, h });
			}

			// try to extract + play audio blob if present
			try {
				if (Module._mv2_get_audio_blob) {
					const outPtrPtr = Module._malloc(4);
					const outSizePtr = Module._malloc(4);
					const ok = Module._mv2_get_audio_blob(mv2, outPtrPtr, outSizePtr);
					if (ok) {
						const audioPtr = Module.getValue(outPtrPtr, 'i32');
						const audioSize = Module.getValue(outSizePtr, 'i32');
						dbg('audio blob', { audioPtr, audioSize });
						if (audioPtr && audioSize > 0) {
							const audioBuf = Module.HEAPU8.subarray(audioPtr, audioPtr + audioSize);
							const blob = new Blob([audioBuf], { type: 'audio/mpeg' });
							const url = URL.createObjectURL(blob);
							if (window.__currentAudio) { try { window.__currentAudio.pause(); URL.revokeObjectURL(window.__currentAudio.src); } catch(e){} }
							const audio = new Audio(url);
							audio.loop = false;
							audio.volume = document.getElementById('volume') ? parseFloat(document.getElementById('volume').value) : 1.0;
							// respect selected playback speed
							try { audio.playbackRate = playbackSpeed; } catch(e) {}
							audio.play().catch(e => console.warn('audio play failed', e));
							window.__currentAudio = audio;
							// free the C buffer returned by mv2_get_audio_blob
							try { Module._free(audioPtr); } catch (e) { console.warn('free audio buffer failed', e); }
						}
					}
					Module._free(outPtrPtr);
					Module._free(outSizePtr);
				}
			} catch (e) { console.warn('audio extraction failed', e); }

			// setup playback state and auto-start
			try {
				if (window.__currentMV2 && window.__currentMV2 !== 0) {
					try { if (Module._mv2_destroy) Module._mv2_destroy(window.__currentMV2); } catch (e) { console.warn('destroy previous mv2 failed', e); }
				}
				window.__currentMV2 = mv2;
				window.__currentFrames = frames;
				window.__currentWidth = w;
				window.__currentHeight = h;
				window.__currentFPS = (Module._mv2_get_fps ? Module._mv2_get_fps(mv2) : 15) || 15;
				window.__currentFrame = 0;
				dbg('autostart playback', { fps: window.__currentFPS, frames });
				startPlayback();
				// enable scanlines overlay by default
				try { const pa = document.getElementById('player-area'); if (pa) pa.classList.add('scanlines'); } catch(e) {}
			} catch (e) { console.error('playback setup failed', e); }

			if (loading) loading.style.display = 'none';
		} catch (e) { console.error('handleFile top-level error', e); if (loading) loading.textContent = 'Error'; }
	}

	drop.addEventListener('dragover', e => { processDragOver(e); try { drop.classList.add('hover'); } catch(e){} });
	drop.addEventListener('dragleave', e => { try { drop.classList.remove('hover'); } catch(e){} });
	drop.addEventListener('drop', e => { processDropEvent(e); try { drop.classList.remove('hover'); } catch(e){} });

	// clicking the dropzone should open the file picker
	try {
		drop.addEventListener('click', e => {
			try {
				e.preventDefault();
				e.stopPropagation();
				const input = document.getElementById('fileinput');
				if (input) input.click();
			} catch (err) { /* ignore */ }
		});
	} catch(e) { /* ignore */ }

	// Also accept drops on the player area and on the canvas element itself
	if (playerArea) {
		playerArea.addEventListener('dragover', e => { processDragOver(e); try { playerArea.classList.add('hover'); } catch(e){} });
		playerArea.addEventListener('dragleave', e => { try { playerArea.classList.remove('hover'); } catch(e){} });
		playerArea.addEventListener('drop', e => { processDropEvent(e); try { playerArea.classList.remove('hover'); } catch(e){} });
	}

	if (canvas) {
		canvas.addEventListener('dragover', e => { processDragOver(e); try { canvas.classList.add('hover'); } catch(e){} });
		canvas.addEventListener('dragleave', e => { try { canvas.classList.remove('hover'); } catch(e){} });
		canvas.addEventListener('drop', e => { processDropEvent(e); try { canvas.classList.remove('hover'); } catch(e){} });
	}

	// Also listen at window level so dropping anywhere on the page still works
	// (prevents browser from navigating to file when dropped)
	try {
		window.addEventListener('dragover', e => { processDragOver(e); });
		window.addEventListener('drop', e => { processDropEvent(e); });
	} catch(e) { console.warn('window drag/drop handlers install failed', e); }

	// clicking the player-area (but not the controls) toggles play/pause when a file is loaded
	if (playerArea) {
		playerArea.addEventListener('click', e => {
			try {
				// ignore clicks on interactive UI elements (controls, fullscreen buttons, inputs)
				if (e.target && (e.target.closest && (e.target.closest('#controls') || e.target.closest('#fullscreen') || e.target.closest('#fsExit') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')))) return;
				// only toggle when click is inside the central 60% area of the player
				const rect = playerArea.getBoundingClientRect();
				const cx = (e.clientX - rect.left) / rect.width;
				const cy = (e.clientY - rect.top) / rect.height;
				const margin = (1 - 0.6) / 2; // center 60%
				if (cx < margin || cx > 1 - margin || cy < margin || cy > 1 - margin) return;
				if (window.__currentMV2 && window.__currentFrames) togglePlay();
			} catch (err) { console.warn('player-area click toggle failed', err); }
		});
	}

	// Fullscreen toggle wiring
	const fsBtn = document.getElementById('fullscreen');
	const fsExit = document.getElementById('fsExit');
	function requestFullscreenFor(el) {
		if (!el) return;
		if (el.requestFullscreen) return el.requestFullscreen();
		if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
		if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
		if (el.msRequestFullscreen) return el.msRequestFullscreen();
	}
	function exitFullscreen() {
		if (document.exitFullscreen) return document.exitFullscreen();
		if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
		if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
		if (document.msExitFullscreen) return document.msExitFullscreen();
	}
	if (fsBtn) fsBtn.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation(); const el = document.getElementById('player-area'); requestFullscreenFor(el); } catch (e) { console.warn('requestFullscreen failed', e); } });
	if (fsExit) fsExit.addEventListener('click', (e) => { try { e.preventDefault(); e.stopPropagation(); exitFullscreen(); } catch (e) { console.warn('exitFullscreen failed', e); } });

	// Keep UI in sync when fullscreen changes
	document.addEventListener('fullscreenchange', () => {
		const isFS = !!document.fullscreenElement;
		const pa = document.getElementById('player-area');
		const canvasEl = document.getElementById('canvas');
		if (pa) {
			if (isFS) pa.classList.add('fullscreen'); else pa.classList.remove('fullscreen');
		}
		// show/hide fsExit when in fullscreen
		if (fsExit) fsExit.style.display = isFS ? 'block' : 'none';

		// Resize canvas to maximize height while preserving aspect ratio when entering fullscreen
		try {
			if (canvasEl) {
				if (isFS) {
					const nativeW = window.__currentWidth || canvasEl.width || 256;
					const nativeH = window.__currentHeight || canvasEl.height || 192;
					const scale = Math.min(window.innerHeight / nativeH, window.innerWidth / nativeW);
					canvasEl.style.height = Math.round(nativeH * scale) + 'px';
					canvasEl.style.width = 'auto';
				} else {
					// restore to previously computed scaled size (if available) outside fullscreen
					try {
						if (canvasEl.dataset && canvasEl.dataset.scaledWidth) canvasEl.style.width = canvasEl.dataset.scaledWidth;
						else canvasEl.style.width = '';
						if (canvasEl.dataset && canvasEl.dataset.scaledHeight) canvasEl.style.height = canvasEl.dataset.scaledHeight;
						else canvasEl.style.height = '';
					} catch (e) { canvasEl.style.width = ''; canvasEl.style.height = ''; }
				}
			}
		} catch (e) { console.warn('fullscreen resize failed', e); }
	});

	const fileinput = document.getElementById('fileinput');
	if (fileinput) fileinput.addEventListener('change', e => { const f = (e.target.files && e.target.files[0]); if (f) { dbg('fileinput change', f.name); handleFile(f); } });

	// wire seek input
	const seekEl = document.getElementById('seek');
	if (seekEl) {
		seekEl.addEventListener('input', e => {
			try {
				const val = parseInt(e.target.value, 10) || 0;
				const fps = window.__currentFPS || 15;
				if (window.__currentAudio) {
					// seek audio which drives video
					try { window.__currentAudio.currentTime = val / fps; } catch (err) { console.warn('audio seek failed', err); }
				}
				// render the target frame immediately
				renderFrameIndex(val);
			} catch (err) { console.warn('seek input handler failed', err); }
		});
	}
}

// Ensure setupDrop runs either now or on DOM ready; runtime init will also attempt to call setupDrop.
if (typeof Module !== 'undefined' && Module.onRuntimeInitialized) { try { setupDrop(); } catch (e) { console.error('setupDrop immediate error', e); } } else { document.addEventListener('DOMContentLoaded', () => { setTimeout(setupDrop, 100); }); }
