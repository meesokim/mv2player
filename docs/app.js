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
	// Make setupDrop idempotent: if it already ran, skip to avoid
	// attaching duplicate event handlers which can cause double dialogs.
	if (window.__mv2_setupDrop_done) { dbg('setupDrop already initialized, skipping'); return; }
	window.__mv2_setupDrop_done = true;
	const drop = document.getElementById('dropzone');
	// On mobile devices, the drop hint is misleading — remove the text but keep the element
	try {
		const isMobile = (typeof navigator !== 'undefined') && (/Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(navigator.userAgent) || ('ontouchstart' in window) || (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
		if (isMobile && drop) {
			try { drop.textContent = ''; } catch(e) {}
		}
	} catch(e) {}
	const canvas = document.getElementById('canvas');
	const controls = document.getElementById('controls');
	const loading = document.getElementById('loading');
	const playerArea = document.getElementById('player-area');
	let __cachedImageData = null;
	let __cachedImageW = 0;
	let __cachedImageH = 0;
	let __renderInProgress = false;
	let __pendingFrame = null;
	if (!drop || !canvas) { console.warn('missing drop or canvas element', { drop: !!drop, canvas: !!canvas }); return; }

	// prevent clicks inside controls from bubbling up to player-area
	if (controls) {
		controls.addEventListener('click', e => { try { e.stopPropagation(); } catch(e) {} });
	}

	function renderRGBAtoCanvas(bufPtr, w, h) {
		try {
			dbg('renderRGBAtoCanvas', { bufPtr, w, h });
			const heap = Module.HEAPU8;
			const len = w * h * 4;
			if (!canvas) { console.error('no canvas'); return; }
			const ctx = canvas.getContext('2d');
			if (!ctx) { console.error('no 2d context'); return; }

			// determine displayed CSS size
			const displayW = Math.max(1, Math.floor(canvas.clientWidth || w));
			const displayH = Math.max(1, Math.floor(canvas.clientHeight || (displayW * h / w)));

			// Use source-sized canvas and let the browser scale via CSS when downscaling.
			// This avoids expensive per-pixel JS sampling and lets the GPU/compositor handle scaling.
			// We still reuse an ImageData instance to avoid reallocations.
			const view = heap.subarray(bufPtr, bufPtr + len);

			// If the canvas size differs from source, set canvas internal size to source
			// and set CSS width/height to display size for GPU scaling.
			canvas.width = w;
			canvas.height = h;
			if (displayW !== w || displayH !== h) {
				canvas.style.width = displayW + 'px';
				canvas.style.height = displayH + 'px';
				// prefer pixelated scaling for crisp low-res visuals
				canvas.style.imageRendering = 'pixelated';
			} else {
				canvas.style.width = '';
				canvas.style.height = '';
				canvas.style.imageRendering = '';
			}

			// reuse ImageData buffer when possible
			if (!__cachedImageData || __cachedImageW !== w || __cachedImageH !== h) {
				__cachedImageData = ctx.createImageData(w, h);
				__cachedImageW = w;
				__cachedImageH = h;
			}

			// copy pixels into cached ImageData and blit
			const t0 = performance.now();
			__cachedImageData.data.set(view);
			ctx.putImageData(__cachedImageData, 0, 0);
			const dur = performance.now() - t0;
			if (dur > 40) dbgWarn('slow frame render', { dur: Math.round(dur), w, h, displayW, displayH });
			dbg('frame rendered', { dur: Math.round(dur) });
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

	// Debounced file input trigger to avoid multiple dialogs
	let __lastFileDialog = 0;
	function triggerFileInput() {
		try {
			const now = Date.now();
			if (now - __lastFileDialog < 300) return; // ignore rapid repeated triggers
			__lastFileDialog = now;
			const input = document.getElementById('fileinput');
			if (input) {
				try { input.click(); } catch(e) { /* ignore */ }
			}
		} catch(e) {}
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
				// set initial canvas size to the smaller of viewport width/height
				const minSide = Math.min(window.innerWidth || pa.clientWidth, window.innerHeight || pa.clientHeight) || pa.clientWidth;
				canvas.style.width = Math.max(160, Math.floor(minSide)) + 'px';
				canvas.style.height = 'auto';
				// remember as scaled size for fullscreen restore logic
				try { canvas.dataset.scaledWidth = canvas.style.width; canvas.dataset.scaledHeight = canvas.style.height || 'auto'; } catch(e) {}
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

	async function renderFrameIndex(idx) {
		// guard against overlapping renders: if a render is in progress,
		// remember the latest requested frame and return quickly.
		try {
			if (!window.__currentMV2) return;
			idx = ((idx % window.__currentFrames) + window.__currentFrames) % window.__currentFrames;
			if (__renderInProgress) {
				__pendingFrame = idx;
				return;
			}
			__renderInProgress = true;
			const ptr = Module._mv2_get_frame_rgba(window.__currentMV2, idx);
			if (ptr && window.__currentWidth > 0 && window.__currentHeight > 0) {
				const w = window.__currentWidth;
				const h = window.__currentHeight;
				const len = w * h * 4;
				const heap = Module.HEAPU8;
				const src = heap.subarray(ptr, ptr + len);
				// copy into a new ImageData (this allocates JS memory but avoids reading Module memory later)
				let imgData = null;
				try {
					imgData = new ImageData(w, h);
					imgData.data.set(src);
				} catch (e) {
					console.warn('ImageData creation failed, falling back to renderRGBAtoCanvas', e);
					try { renderRGBAtoCanvas(ptr, w, h); } catch(err) { console.error('fallback render failed', err); }
					try { Module._mv2_free_buffer(ptr); } catch (e2) { console.warn('free_buffer failed during renderFrame', e2); }
					return;
				}
				// free C buffer as we've copied pixels
				try { Module._mv2_free_buffer(ptr); } catch (e) { console.warn('free_buffer failed during renderFrame', e); }

				// determine display size (respect CSS scaled widths if present)
				const displayW = Math.max(1, Math.floor(canvas.clientWidth || w));
				const displayH = Math.max(1, Math.floor(canvas.clientHeight || Math.floor(displayW * h / w)));

				try {
					// keep internal canvas resolution equal to source to avoid cropping
					canvas.width = w;
					canvas.height = h;
					const ctx = canvas.getContext('2d');
					// use createImageBitmap for async/optimized upload then draw at source size;
					// CSS will scale the canvas to the desired displayed size set earlier.
					const bmp = await createImageBitmap(imgData);
					ctx.imageSmoothingEnabled = false;
					ctx.drawImage(bmp, 0, 0, w, h);
					try { bmp.close(); } catch(_) {}
				} catch (e) { console.error('drawImage failed', e); }
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
		finally {
			__renderInProgress = false;
			if (__pendingFrame !== null) {
				const pf = __pendingFrame;
				__pendingFrame = null;
				requestAnimationFrame(() => { try { renderFrameIndex(pf); } catch(e) { console.warn('deferred render failed', e); } });
			}
		}
	}

	function rafLoop(ts) {
		const t0 = performance.now();
		try {
			if (!isPlaying) return;
			const fps = window.__currentFPS || 15;
			if (window.__currentAudio && !isNaN(window.__currentAudio.duration) && window.__currentAudio.duration > 0) {
				// compute target frame quickly and schedule render asynchronously
				const audioTime = window.__currentAudio.currentTime || 0;
				const targetFrame = Math.floor(audioTime * fps);
				if (targetFrame !== window.__currentFrame) {
					if (__renderInProgress) {
						__pendingFrame = targetFrame;
					} else {
						requestAnimationFrame(() => { try { renderFrameIndex(targetFrame); } catch(e) { console.warn('deferred render failed', e); } });
					}
				}
			} else {
				// no-audio path should not be on rAF heavy loop; keep small guard here
				if (!lastTick) lastTick = ts;
				const elapsed = ts - lastTick;
				const effectiveFps = fps * playbackSpeed;
				const frameDuration = 1000 / effectiveFps;
				if (elapsed >= frameDuration) {
					const skip = Math.floor(elapsed / frameDuration);
					const target = window.__currentFrame + skip;
					if (__renderInProgress) {
						__pendingFrame = target;
					} else {
						requestAnimationFrame(() => { try { renderFrameIndex(target); } catch(e) { console.warn('deferred render failed', e); } });
					}
					lastTick = ts;
				}
			}
		} catch (e) { console.error('rafLoop error', e); }
		const dur = performance.now() - t0;
		if (dur > 20) dbgWarn('slow rafLoop', { dur: Math.round(dur) });
		// schedule next frame only when audio is present; non-audio uses setTimeout scheduler
		if (window.__currentAudio && !isNaN(window.__currentAudio.duration) && window.__currentAudio.duration > 0) {
			rafId = requestAnimationFrame(rafLoop);
		}
	}

	function startPlayback() {
		try {
			stopPlayback();
			if (!window.__currentMV2 || !window.__currentFrames) return;
			// try to play audio if present
			try {
				if (window.__currentAudio) {
					try { window.__currentAudio.playbackRate = playbackSpeed; } catch(e) {}
					const p = window.__currentAudio.play();
					if (p && p.catch) p.catch(err => console.warn('audio play blocked', err));
					const volEl = document.getElementById('volume');
					if (volEl) window.__currentAudio.volume = parseFloat(volEl.value);
				}
			} catch (e) { console.warn('audio resume failed', e); }
			isPlaying = true;
			lastTick = 0;
			// If audio is present, use requestAnimationFrame for tight sync. Otherwise use setTimeout
			if (window.__currentAudio && !isNaN(window.__currentAudio.duration) && window.__currentAudio.duration > 0) {
				rafId = requestAnimationFrame(rafLoop);
			} else {
				// schedule first no-audio tick based on frame duration
				const fps = window.__currentFPS || 15;
				const effectiveFps = fps * playbackSpeed;
				const frameDuration = Math.max(1, Math.round(1000 / effectiveFps));
				if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
				playbackTimer = setTimeout(function noAudioTick() {
					try {
						const now = performance.now();
						if (!lastTick) lastTick = now;
						const elapsed = now - lastTick;
						const skip = Math.max(1, Math.floor(elapsed / frameDuration));
						const target = window.__currentFrame + skip;
						// keep the timeout handler minimal: compute target and schedule actual rendering
						// via requestAnimationFrame to avoid long-running setTimeout handlers.
						lastTick = now;
						requestAnimationFrame(() => {
							try { renderFrameIndex(target); } catch(e) { console.warn('renderFrameIndex failed', e); }
						});
					} catch(e) { console.warn('noAudioTick failed', e); }
					if (isPlaying) playbackTimer = setTimeout(noAudioTick, frameDuration);
				}, frameDuration);
			}
			updatePlayButton(true);
		} catch (e) { console.error('startPlayback error', e); }
	}

	function stopPlayback() {
		try {
			if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
			if (playbackTimer) { clearTimeout(playbackTimer); playbackTimer = null; }
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

			// cleanup previous playback and wasm resources to avoid leaks
			try { stopPlayback(); } catch(e) {}
			try {
				if (window.__currentAudio) {
					try { window.__currentAudio.pause(); } catch(e) {}
					try { URL.revokeObjectURL(window.__currentAudio.src); } catch(e) {}
					window.__currentAudio = null;
				}
			} catch(e) {}
			try {
				if (window.__currentMV2 && Module && Module._mv2_destroy) {
					try { Module._mv2_destroy(window.__currentMV2); } catch(e) { dbgWarn('mv2 destroy failed', e); }
				}
			} catch(e) {}
			window.__currentMV2 = 0;
			window.__currentFrames = 0;
			window.__currentWidth = 0;
			window.__currentHeight = 0;
			window.__currentFPS = 0;
			window.__currentFrame = 0;

			if (loading) {
				loading.textContent = 'Loading... (0%)';
				loading.style.display = 'block';
			}
			function readFileWithProgress(f, onProgress) {
				return new Promise((resolve, reject) => {
					if (window.FileReader) {
						const r = new FileReader();
						let lastLoaded = 0;
						let totalSize = 0;
						let estimated = 0;
						let poll = null;
						r.onerror = () => {
							if (poll) clearInterval(poll);
							reject(new Error('file read error'));
						};
						r.onprogress = ev => {
							if (ev.lengthComputable) {
								lastLoaded = ev.loaded;
								totalSize = ev.total;
								if (onProgress) onProgress(Math.round((lastLoaded/totalSize)*100));
							}
						};
						r.onload = () => {
							if (poll) clearInterval(poll);
							try { if (onProgress) onProgress(100); } catch(e){}
							try { resolve(new Uint8Array(r.result)); } catch(e) { reject(e); }
						};
						// periodic poll to update UI at least every 2s while reading
						poll = setInterval(() => {
							try {
								if (totalSize > 0) {
									const pct = Math.round((lastLoaded/totalSize)*100);
									if (onProgress) onProgress(pct);
								} else {
									estimated = Math.min(99, estimated + 5);
									if (onProgress) onProgress(estimated);
								}
							} catch(e){}
						}, 2000);
						r.readAsArrayBuffer(f);
					} else {
						// fallback: no progress events available, use arrayBuffer()
						f.arrayBuffer().then(ab => { try { if (onProgress) onProgress(100); } catch(e){}; resolve(new Uint8Array(ab)); }).catch(err => { if (poll) clearInterval(poll); reject(err); });
					}
				});
			}
			// Start a 2s UI poll to show progress even if FileReader events are sparse
			window.__mv2_read_progress = 0;
			let __mv2_progress_interval = setInterval(() => {
				try { if (loading) loading.textContent = 'Loading... (' + Math.min(99, window.__mv2_read_progress) + '%)'; } catch(e){}
			}, 2000);
			const u8 = await readFileWithProgress(file, pct => { try { window.__mv2_read_progress = pct; if (loading) loading.textContent = 'Loading... (' + pct + '%)'; } catch(e){} });
			try { clearInterval(__mv2_progress_interval); } catch(e){}
			try { if (loading) loading.textContent = 'Loading... (100%)'; } catch(e){}
			dbg('handleFile: file bytes', u8.length, file && file.name);

			const ptr = Module._malloc(u8.length);
			dbg('handleFile: malloc ptr', ptr);
			Module.HEAPU8.set(u8, ptr);

			let mv2 = 0;
			try {
				// If the uploaded file is a ZIP, extract the first .mv2 using the wasm helper
				const isZip = (file && file.name && file.name.toLowerCase().endsWith('.zip')) || (file && file.type === 'application/zip');
				if (isZip && Module._extract_first_mv2_from_zip) {
					const outPtrPtr = wasmAlloc(4);
					const outSizePtr = wasmAlloc(4);
					let ok = 0;
					try {
						ok = Module._extract_first_mv2_from_zip(ptr, u8.length, outPtrPtr, outSizePtr);
					} catch(e) { console.error('extract_first_mv2_from_zip threw', e); }
					if (ok) {
						const extractedPtr = Module.getValue(outPtrPtr, 'i32');
						const extractedSize = Module.getValue(outSizePtr, 'i32');
								dbg('handleFile: extracted mv2 from zip', { extractedPtr, extractedSize });
						if (extractedPtr && extractedSize > 0) {
							try {
								// yield to event loop to allow UI (Loading...) to repaint before heavy wasm work
								try { if (loading) loading.textContent = 'Parsing...'; } catch(e){}
								await new Promise(r => setTimeout(r, 0));
								mv2 = Module._mv2_create_from_memory(extractedPtr, extractedSize);
							} catch (e) { console.error('mv2_create_from_memory (from extracted) threw', e); }
							try { Module._free(extractedPtr); } catch(e){}
						}
					}
					try { wasmFree(outPtrPtr); wasmFree(outSizePtr); } catch(e){}
				} else {
					try {
						try { if (loading) loading.textContent = 'Parsing...'; } catch(e){}
						await new Promise(r => setTimeout(r, 0));
						mv2 = Module._mv2_create_from_memory(ptr, u8.length);
					} catch (e) {
						console.error('mv2_create_from_memory threw', e);
					}
				}
			} catch (e) {
				console.error('mv2 create path failed', e);
			}
			try { Module._free(ptr); } catch (e) { console.warn('free failed', e); }

			dbg('handleFile: mv2 handle', mv2);
			if (!mv2) { console.error('mv2 create failed'); if (loading) loading.textContent = 'Failed to load'; return; }

			let w = 0, h = 0, frames = 0;
			try { w = Module._mv2_get_width(mv2); } catch (e) { console.error('_mv2_get_width error', e); }
			try { h = Module._mv2_get_height(mv2); } catch (e) { console.error('_mv2_get_height error', e); }
			try { frames = Module._mv2_get_num_frames(mv2); } catch (e) { console.error('_mv2_get_num_frames error', e); }
			dbg('handleFile: mv2 loaded', { w, h, frames });

			// scale canvas to maximally fit the browser viewport while forcing a 4:3 display aspect ratio
			try {
				const container = document.getElementById('player-area');
				if (canvas) {
					function adjustCanvasScale(srcW, srcH) {
						// Use the player-area container to determine available space so the canvas
						// never exceeds the visible area and does not get clipped vertically.
						const viewW = (container && container.clientWidth) || window.innerWidth || 800;
						const viewH = (container && container.clientHeight) || window.innerHeight || 600;
						// compute scale that fits both width and height (allow downscaling < 1)
						let scale = Math.min(viewW / srcW, viewH / srcH);
						// clamp scale to reasonable bounds (allow downscale to 0.25x)
						scale = Math.max(0.25, Math.min(scale, 6));
						const appliedW = Math.floor(srcW * scale);
						const appliedH = Math.floor(srcH * scale);
						// set CSS size while keeping internal canvas resolution equal to source
						canvas.style.width = appliedW + 'px';
						canvas.style.height = appliedH + 'px';
						// ensure CSS won't allow the canvas to overflow the container
						canvas.style.maxWidth = '100%';
						canvas.style.maxHeight = '100%';
						try { canvas.dataset.scaledWidth = canvas.style.width; canvas.dataset.scaledHeight = canvas.style.height; } catch(e) {}
						try { updateControlsWidth(); } catch(e) {}
						dbg('canvas scaled to viewport (fit both dims)', { scale, appliedW, appliedH, viewW, viewH });
					}

					adjustCanvasScale(w, h);
					// update on window resize to keep either width or height matched
					try {
						window.addEventListener('resize', () => {
							try { if (window.__currentWidth && window.__currentHeight) adjustCanvasScale(window.__currentWidth, window.__currentHeight); else adjustCanvasScale(w, h); } catch(e) {}
						});
					} catch(e) {}
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
				console.error('no frame available or invalid dimensions', {
					mv2, framePtr, w, h, frames,
					exportsPresent: {
						mv2_create: !!(Module && Module._mv2_create_from_memory),
						get_frame: !!(Module && Module._mv2_get_frame_rgba),
						free_buffer: !!(Module && Module._mv2_free_buffer),
						malloc: !!(Module && Module._malloc)
					}
				});
				try { if (loading) loading.textContent = 'Invalid MV2 (no frames)'; } catch(e){}
				// if mv2 was created but invalid, attempt to destroy to avoid leaked state
				try { if (mv2 && Module && Module._mv2_destroy) Module._mv2_destroy(mv2); } catch(e) { dbgWarn('mv2 destroy failed', e); }
				return;
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
				// apply scanlines preference (controlled by checkbox `#scanlinesToggle`, persisted in localStorage)
				try {
					const pa = document.getElementById('player-area');
					const toggle = document.getElementById('scanlinesToggle');
					if (toggle && pa) {
						// restore saved preference if present
						try {
							const saved = (window.localStorage && window.localStorage.getItem && window.localStorage.getItem('mv2_scanlines'));
							if (saved !== null) toggle.checked = saved === '1';
						} catch(e) {}
						const apply = (checked) => { try { if (checked) pa.classList.add('scanlines'); else pa.classList.remove('scanlines'); } catch(e){} };
						apply(toggle.checked);
						toggle.addEventListener('change', (e) => { try { apply(e.target.checked); if (window.localStorage && window.localStorage.setItem) window.localStorage.setItem('mv2_scanlines', e.target.checked ? '1' : '0'); } catch(e){} });
					} else if (pa) {
						// fallback: enable scanlines
						try { pa.classList.add('scanlines'); } catch(e){}
					}
				} catch(e) {}
			} catch (e) { console.error('playback setup failed', e); }

			if (loading) loading.style.display = 'none';
		} catch (e) { console.error('handleFile top-level error', e); if (loading) loading.textContent = 'Error'; }
	}

	drop.addEventListener('dragover', e => { processDragOver(e); try { drop.classList.add('hover'); } catch(e){} });
	drop.addEventListener('dragleave', e => { try { drop.classList.remove('hover'); } catch(e){} });
	drop.addEventListener('drop', e => { processDropEvent(e); try { drop.classList.remove('hover'); } catch(e){} });

	// Add a visible "Open file" button inside the dropzone (don't use dropzone click)
	try {
		let dropBtn = document.getElementById('drop-openfile');
		if (!dropBtn) {
			dropBtn = document.createElement('button');
			dropBtn.id = 'drop-openfile';
			dropBtn.className = 'icon-btn drop-openfile';
			dropBtn.textContent = 'Open File';
			try { drop.appendChild(dropBtn); } catch(e) { /* ignore */ }
		}
			dropBtn.addEventListener('click', e => {
				try {
					e.preventDefault(); e.stopPropagation();
					triggerFileInput();
				} catch (err) {}
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
				// If no file loaded, open file dialog instead
				if (!window.__currentMV2 || !window.__currentFrames) {
					try { triggerFileInput(); return; } catch(e){}
				}
				// otherwise: on mobile (or any device) if the visible canvas is taller than wide
				// prefer to scale the canvas to match the container width. If the visible
				// canvas is wider than tall, perform the usual play/pause toggle.
				const canvasEl = document.getElementById('canvas');
				if (canvasEl) {
					try {
						const crect = canvasEl.getBoundingClientRect();
						if (crect.height > crect.width) {
							// scale to fit width
							try { canvasEl.style.width = '100%'; canvasEl.style.height = 'auto'; } catch(e){}
							try { canvasEl.dataset.scaledWidth = canvasEl.style.width; canvasEl.dataset.scaledHeight = canvasEl.style.height || 'auto'; } catch(e){}
							try { updateControlsWidth(); } catch(e){}
							return;
						}
					} catch(e) { /* ignore */ }
				}
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
	if (fileinput) {
		// On some mobile browsers (Android/iOS), the file picker UI is filtered
		// aggressively based on `accept`. Force a generic picker on mobile so
		// users can choose arbitrary files (e.g. .mv2/.zip) instead of only
		// media types.
		try {
			const ua = (navigator && navigator.userAgent) ? navigator.userAgent : '';
			const isMobile = /Android|webOS|iPhone|iPad|iPod|Mobile/i.test(ua);
			if (isMobile) {
				dbg('mobile platform detected, relaxing file input accept to */*');
				try { fileinput.accept = '*/*'; } catch(e) {}
			}
		} catch(e) {}

		fileinput.addEventListener('change', e => { const f = (e.target.files && e.target.files[0]); if (f) { dbg('fileinput change', f.name); handleFile(f); } });
		// wire existing openfile button in controls to the hidden input
		try {
			const openBtn = document.getElementById('openfile');
			if (openBtn) openBtn.addEventListener('click', ev => { try { ev.preventDefault(); ev.stopPropagation(); triggerFileInput(); } catch(e){} });
		} catch(e) {}
	}

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
