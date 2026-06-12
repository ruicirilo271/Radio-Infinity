(() => {
    "use strict";

    const audio = document.getElementById("audio");
    const powerBtn = document.getElementById("powerBtn");
    const reconnectBtn = document.getElementById("reconnectBtn");
    const muteBtn = document.getElementById("muteBtn");
    const muteIcon = document.getElementById("muteIcon");
    const volumeSlider = document.getElementById("volumeSlider");

    const cover = document.getElementById("cover");
    const programName = document.getElementById("programName");
    const trackTitle = document.getElementById("trackTitle");
    const trackArtist = document.getElementById("trackArtist");
    const nextTrack = document.getElementById("nextTrack");
    const nextProgram = document.getElementById("nextProgram");
    const countdown = document.getElementById("countdown");
    const modeBadge = document.getElementById("modeBadge");
    const listenerCount = document.getElementById("listenerCount");

    const connectionDot = document.getElementById("connectionDot");
    const connectionText = document.getElementById("connectionText");
    const headerStatus = document.getElementById("headerStatus");
    const serverStatus = document.getElementById("serverStatus");
    const qualityStatus = document.getElementById("qualityStatus");
    const lisbonClock = document.getElementById("lisbonClock");

    const historyList = document.getElementById("historyList");
    const autoModeBtn = document.getElementById("autoModeBtn");
    const scheduleItems = [...document.querySelectorAll(".schedule-item")];
    const toast = document.getElementById("toast");

    const canvas = document.getElementById("spectrum");
    const ctx = canvas.getContext("2d");

    const STORAGE_KEY = "infinity-radio-vercel-v3";
    const OLD_STORAGE_KEYS = [
        "infinity-radio-vercel-v2",
        "infinity-radio-vercel-v1",
        "infinity-radio-state-v4",
        "infinity-radio-state-v3",
    ];
    const LEGACY_VOLUME_KEY = "infinity-volume";

    let playlist = [];
    let trackIndex = 0;
    let currentFolder = null;
    let currentProgram = null;
    let pendingTrack = null;
    let shouldPlay = false;
    let intentionalSourceChange = false;
    let retryCount = 0;
    let reconnectTimer = null;
    let stallTimer = null;
    let toastTimer = null;
    let history = [];
    let manualProgram = null;
    let storageEnabled = true;
    let playlistChunkBytes = 3_750_000;
    let playGeneration = 0;
    let activeTrackId = null;

    const preparedTracks = new Map();
    const downloadJobs = new Map();

    let audioContext = null;
    let analyser = null;
    let sourceNode = null;
    let frequencyData = null;

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function safeLocalGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            storageEnabled = false;
            console.warn("LocalStorage indisponível:", error);
            return null;
        }
    }

    function readLocalState() {
        for (const key of [STORAGE_KEY, ...OLD_STORAGE_KEYS]) {
            const raw = safeLocalGet(key);
            if (!raw) continue;

            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") return parsed;
            } catch (error) {
                console.warn(`Estado inválido em ${key}:`, error);
            }
        }
        return {};
    }

    function storedNumber(value) {
        if (value === null || value === undefined || value === "") return NaN;
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
    }

    function normaliseHistory(items) {
        if (!Array.isArray(items)) return [];
        return items
            .filter(item => item && typeof item === "object" && item.id)
            .slice(0, 10)
            .map(item => ({
                id: String(item.id),
                title: String(item.title || "Música"),
                artist: String(item.artist || "Infinity Radio"),
                cover: String(item.cover || cover.dataset.default),
                program: String(item.program || "Infinity Radio"),
                time: String(item.time || "--:--"),
            }));
    }

    function normaliseManualProgram(value) {
        if (!value || typeof value !== "object") return null;
        const folder = String(value.folder || "").trim();
        const name = String(value.name || "").trim();
        return folder && name ? { folder, name } : null;
    }

    function saveLocalState() {
        if (!storageEnabled) return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                version: 3,
                volume: audio.volume,
                history: history.slice(0, 10),
                manualProgram,
                savedAt: new Date().toISOString(),
            }));
            localStorage.setItem(LEGACY_VOLUME_KEY, String(audio.volume));
        } catch (error) {
            storageEnabled = false;
            console.warn("Não foi possível guardar no LocalStorage:", error);
        }
    }

    const savedState = readLocalState();
    const storedVolume = storedNumber(savedState.volume);
    const legacyVolume = storedNumber(safeLocalGet(LEGACY_VOLUME_KEY));
    const initialVolume = Number.isFinite(storedVolume)
        ? storedVolume
        : (Number.isFinite(legacyVolume) && legacyVolume > 0 ? legacyVolume : 0.8);

    audio.volume = clamp(initialVolume, 0.05, 1);
    audio.muted = false;
    volumeSlider.value = String(audio.volume);
    muteIcon.textContent = "🔊";
    history = normaliseHistory(savedState.history);
    manualProgram = normaliseManualProgram(savedState.manualProgram);

    function queryString(includeCacheBuster = true) {
        const params = new URLSearchParams();
        if (includeCacheBuster) params.set("v", String(Date.now()));
        if (manualProgram) {
            params.set("folder", manualProgram.folder);
            params.set("name", manualProgram.name);
        }
        return params.toString();
    }

    function apiUrl(path) {
        const query = queryString(true);
        return query ? `${path}?${query}` : path;
    }

    function withCacheBuster(url) {
        const separator = url.includes("?") ? "&" : "?";
        return `${url}${separator}v=${Date.now()}`;
    }

    function showToast(message, isError = false) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.toggle("error", isError);
        toast.classList.add("show");
        toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
    }

    function setConnection(state, text) {
        connectionDot.className = "connection-dot";
        if (state) connectionDot.classList.add(state);
        connectionText.textContent = text;

        if (state === "online") {
            headerStatus.textContent = "EMISSÃO LIGADA";
            document.body.classList.add("is-playing");
        } else if (state === "connecting") {
            headerStatus.textContent = "A PREPARAR";
            document.body.classList.remove("is-playing");
        } else if (state === "error") {
            headerStatus.textContent = "A RECONECTAR";
            document.body.classList.remove("is-playing");
        } else {
            headerStatus.textContent = "PRONTA PARA LIGAR";
            document.body.classList.remove("is-playing");
        }
    }

    async function removeLegacyServiceWorkers() {
        if (!("serviceWorker" in navigator)) return;
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(registration => registration.unregister()));
        } catch (error) {
            console.warn("Não foi possível remover o Service Worker antigo:", error);
        }
    }

    async function ensureAudioGraph() {
        if (audioContext) {
            if (audioContext.state === "suspended") await audioContext.resume();
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;

        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.82;
        sourceNode = audioContext.createMediaElementSource(audio);
        sourceNode.connect(analyser);
        analyser.connect(audioContext.destination);
        frequencyData = new Uint8Array(analyser.frequencyBinCount);
    }

    function roundedRect(context, x, y, width, height, radius) {
        context.beginPath();
        context.moveTo(x + radius, y);
        context.arcTo(x + width, y, x + width, y + height, radius);
        context.arcTo(x + width, y + height, x, y + height, radius);
        context.arcTo(x, y + height, x, y, radius);
        context.arcTo(x, y, x + width, y, radius);
        context.closePath();
    }

    function drawSpectrum() {
        requestAnimationFrame(drawSpectrum);
        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const gradient = ctx.createLinearGradient(0, height, width, 0);
        gradient.addColorStop(0, "rgba(90,114,255,.92)");
        gradient.addColorStop(0.5, "rgba(110,243,255,.95)");
        gradient.addColorStop(1, "rgba(188,92,255,.92)");

        const active = analyser && frequencyData && !audio.paused && !audio.muted;
        if (active) analyser.getByteFrequencyData(frequencyData);

        const bars = 72;
        const gap = 5;
        const barWidth = (width - gap * (bars - 1)) / bars;

        for (let index = 0; index < bars; index += 1) {
            const frequencyIndex = Math.floor((index / bars) * (frequencyData?.length || 1) * 0.72);
            const value = active
                ? frequencyData[frequencyIndex] / 255
                : 0.055 + Math.sin(Date.now() / 720 + index * 0.5) * 0.018;
            const barHeight = Math.max(4, value * (height - 18));
            const x = index * (barWidth + gap);
            const y = height - barHeight;

            ctx.fillStyle = gradient;
            ctx.globalAlpha = active ? 0.95 : 0.28;
            roundedRect(ctx, x, y, barWidth, barHeight, Math.min(7, barWidth / 2));
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function paintVolume() {
        const percentage = Math.round(Number(volumeSlider.value) * 100);
        volumeSlider.style.background =
            `linear-gradient(90deg,var(--cyan) ${percentage}%,rgba(255,255,255,.12) ${percentage}%)`;
    }

    function formatDuration(totalSeconds) {
        if (totalSeconds === null || totalSeconds === undefined) return "MANUAL";
        const seconds = Math.max(0, Number(totalSeconds));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const rest = Math.floor(seconds % 60);
        return [hours, minutes, rest].map(value => String(value).padStart(2, "0")).join(":");
    }

    function formatClock(isoDate, includeSeconds = true) {
        if (!isoDate) return "--:--";
        return new Intl.DateTimeFormat("pt-PT", {
            hour: "2-digit",
            minute: "2-digit",
            second: includeSeconds ? "2-digit" : undefined,
            timeZone: "Europe/Lisbon",
        }).format(new Date(isoDate));
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function renderHistory() {
        if (!history.length) {
            historyList.innerHTML = '<div class="empty-state">O histórico aparece quando ligares a rádio.</div>';
            return;
        }

        const defaultCover = cover.dataset.default;
        historyList.innerHTML = history.map(item => `
            <div class="history-item">
                <img class="history-cover" src="${escapeHtml(item.cover)}"
                     onerror="this.src='${escapeHtml(defaultCover)}'" alt="">
                <div class="history-copy">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span>${escapeHtml(item.artist)}</span>
                </div>
                <div class="history-meta">
                    <strong>${escapeHtml(item.program)}</strong>
                    <span>${escapeHtml(item.time)}</span>
                </div>
            </div>
        `).join("");
    }

    function updateCover(track) {
        if (!track?.cover) {
            cover.src = cover.dataset.default;
            return;
        }
        const image = new Image();
        image.onload = () => { cover.src = image.src; };
        image.onerror = () => { cover.src = cover.dataset.default; };
        image.src = withCacheBuster(track.cover);
    }

    function showCurrentTrack(track) {
        trackTitle.textContent = track.title || "Música";
        trackArtist.textContent = track.artist || "Infinity Radio";
        updateCover(track);

        const next = playlist[(trackIndex + 1) % playlist.length];
        nextTrack.textContent = next ? `${next.artist} — ${next.title}` : "—";

        if (history[0]?.id !== track.id) {
            history.unshift({
                id: track.id,
                title: track.title,
                artist: track.artist,
                cover: track.cover,
                program: currentProgram || "Infinity Radio",
                time: formatClock(new Date().toISOString(), false),
            });
            history = history.slice(0, 10);
            saveLocalState();
            renderHistory();
        }
    }

    function chunkUrl(track, offset) {
        const separator = track.chunk.includes("?") ? "&" : "?";
        return `${track.chunk}${separator}offset=${offset}&prefetch=1&v=${Date.now()}`;
    }

    async function fetchAudioChunk(track, offset, signal, attempts = 3) {
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const response = await fetch(chunkUrl(track, offset), {
                    cache: "no-store",
                    signal,
                });

                if (!response.ok) {
                    const detail = await response.text().catch(() => "");
                    throw new Error(detail || `Bloco HTTP ${response.status}`);
                }

                const payload = await response.arrayBuffer();
                if (!payload.byteLength) throw new Error("O bloco de áudio veio vazio.");
                return payload;
            } catch (error) {
                if (signal.aborted) throw error;
                lastError = error;
                await sleep(600 * attempt);
            }
        }
        throw lastError || new Error("Não foi possível carregar o áudio.");
    }

    function revokePrepared(trackId) {
        const entry = preparedTracks.get(trackId);
        if (!entry) return;
        URL.revokeObjectURL(entry.url);
        preparedTracks.delete(trackId);
    }

    function abortDownloads(exceptIds = new Set()) {
        for (const [trackId, job] of downloadJobs.entries()) {
            if (!exceptIds.has(trackId)) job.controller.abort();
        }
    }

    function clearPrepared(exceptIds = new Set()) {
        for (const trackId of [...preparedTracks.keys()]) {
            if (!exceptIds.has(trackId)) revokePrepared(trackId);
        }
    }

    async function prepareTrack(track, { foreground = false, generation = null } = {}) {
        const cached = preparedTracks.get(track.id);
        if (cached) {
            cached.lastUsed = Date.now();
            return cached;
        }

        const existing = downloadJobs.get(track.id);
        if (existing) return existing.promise;

        const totalSize = Number(track.size);
        if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
            throw new Error(`Tamanho inválido para ${track.title}.`);
        }

        const controller = new AbortController();
        const offsets = [];
        for (let offset = 0; offset < totalSize; offset += playlistChunkBytes) {
            offsets.push(offset);
        }

        const promise = (async () => {
            const parts = new Array(offsets.length);
            let nextIndex = 0;
            let completedBytes = 0;
            const concurrency = foreground ? 4 : 2;

            const worker = async () => {
                while (true) {
                    const partIndex = nextIndex;
                    nextIndex += 1;
                    if (partIndex >= offsets.length) return;

                    if (generation !== null && generation !== playGeneration) {
                        controller.abort();
                        throw new DOMException("Reprodução substituída.", "AbortError");
                    }

                    const offset = offsets[partIndex];
                    const payload = await fetchAudioChunk(track, offset, controller.signal);
                    parts[partIndex] = payload;
                    completedBytes += payload.byteLength;

                    if (foreground && generation === playGeneration) {
                        const percent = Math.min(100, Math.round((completedBytes / totalSize) * 100));
                        setConnection("connecting", `A preparar ${track.title}… ${percent}%`);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, worker));

            if (controller.signal.aborted) {
                throw new DOMException("Download cancelado.", "AbortError");
            }

            const blob = new Blob(parts, { type: "audio/mpeg" });
            if (blob.size !== totalSize) {
                throw new Error(`A faixa ficou incompleta (${blob.size}/${totalSize} bytes).`);
            }

            const entry = {
                id: track.id,
                url: URL.createObjectURL(blob),
                size: blob.size,
                lastUsed: Date.now(),
            };
            preparedTracks.set(track.id, entry);
            return entry;
        })().finally(() => {
            downloadJobs.delete(track.id);
        });

        downloadJobs.set(track.id, { controller, promise });
        return promise;
    }

    async function preloadNextTrack() {
        if (!shouldPlay || playlist.length < 2) return;
        const next = playlist[(trackIndex + 1) % playlist.length];
        if (!next || preparedTracks.has(next.id) || downloadJobs.has(next.id)) return;

        try {
            await prepareTrack(next, { foreground: false });
            const keep = new Set([activeTrackId, next.id].filter(Boolean));
            clearPrepared(keep);
            qualityStatus.textContent = "MP3 local + próxima pronta";
        } catch (error) {
            if (error?.name !== "AbortError") {
                console.warn("Pré-carregamento da próxima faixa falhou:", error);
                qualityStatus.textContent = "MP3 local";
            }
        }
    }

    async function loadPlaylist({ autoplay = false, preserveIndex = false } = {}) {
        const response = await fetch(apiUrl("/api/player/playlist"), { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Não foi possível carregar a playlist.");

        abortDownloads();
        clearPrepared();

        playlist = Array.isArray(data.tracks) ? data.tracks : [];
        playlistChunkBytes = Number(data.tmp?.range_bytes) || 3_750_000;
        currentFolder = data.program.folder;
        currentProgram = data.program.name;
        programName.textContent = currentProgram;
        modeBadge.textContent = data.program.mode === "manual" ? "MODO MANUAL" : "MODO AUTOMÁTICO";
        modeBadge.classList.toggle("manual", data.program.mode === "manual");
        autoModeBtn.classList.toggle("active", data.program.mode === "auto");

        if (!playlist.length) throw new Error("A pasta deste programa não tem músicas MP3.");
        if (!preserveIndex || trackIndex >= playlist.length) trackIndex = 0;

        const current = playlist[trackIndex];
        const next = playlist[(trackIndex + 1) % playlist.length];
        nextTrack.textContent = next ? `${next.artist} — ${next.title}` : "—";

        if (!shouldPlay && current) {
            trackTitle.textContent = current.title;
            trackArtist.textContent = current.artist;
        }

        if (autoplay && shouldPlay) await playCurrentTrack();
    }

    async function playCurrentTrack() {
        if (!playlist.length) await loadPlaylist();

        clearTimeout(reconnectTimer);
        clearTimeout(stallTimer);
        retryCount = 0;
        intentionalSourceChange = true;
        const generation = ++playGeneration;
        const track = playlist[trackIndex];
        pendingTrack = track;

        audio.pause();
        audio.removeAttribute("src");
        audio.load();

        setConnection("connecting", `A preparar ${track.title}…`);
        qualityStatus.textContent = "A descarregar a faixa";

        try {
            const prepared = await prepareTrack(track, { foreground: true, generation });
            if (generation !== playGeneration || !shouldPlay) return;

            const previousId = activeTrackId;
            activeTrackId = track.id;
            audio.src = prepared.url;
            audio.load();
            await audio.play();

            if (previousId && previousId !== activeTrackId) {
                revokePrepared(previousId);
            }

            const next = playlist[(trackIndex + 1) % playlist.length];
            const keep = new Set([activeTrackId, next?.id].filter(Boolean));
            clearPrepared(keep);
        } finally {
            intentionalSourceChange = false;
        }
    }

    async function startRadio() {
        shouldPlay = true;

        if (audio.volume < 0.05) {
            audio.volume = 0.8;
            volumeSlider.value = "0.8";
            paintVolume();
        }
        audio.muted = false;
        muteIcon.textContent = "🔊";
        saveLocalState();

        await ensureAudioGraph();
        powerBtn.classList.add("active");
        powerBtn.querySelector(".power-icon").textContent = "■";
        powerBtn.querySelector(".power-text").textContent = "DESLIGAR";

        try {
            if (!playlist.length) await loadPlaylist();
            await playCurrentTrack();
        } catch (error) {
            if (error?.name === "AbortError") return;
            console.error(error);
            shouldPlay = false;
            powerBtn.classList.remove("active");
            powerBtn.querySelector(".power-icon").textContent = "▶";
            powerBtn.querySelector(".power-text").textContent = "LIGAR RÁDIO";
            setConnection("error", "Não foi possível iniciar a emissão");
            showToast(error.message || "Falha ao iniciar o áudio.", true);
        }
    }

    function stopRadio() {
        shouldPlay = false;
        intentionalSourceChange = true;
        ++playGeneration;
        clearTimeout(reconnectTimer);
        clearTimeout(stallTimer);
        abortDownloads();
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        pendingTrack = null;
        activeTrackId = null;
        clearPrepared();
        intentionalSourceChange = false;

        powerBtn.classList.remove("active");
        powerBtn.querySelector(".power-icon").textContent = "▶";
        powerBtn.querySelector(".power-text").textContent = "LIGAR RÁDIO";
        setConnection("", "Rádio desligada");
        qualityStatus.textContent = "MP3 por blocos";
    }

    async function nextSong() {
        if (!playlist.length) return;
        retryCount = 0;
        trackIndex = (trackIndex + 1) % playlist.length;
        await playCurrentTrack();
    }

    function retryOrSkip() {
        if (!shouldPlay || intentionalSourceChange) return;
        clearTimeout(reconnectTimer);

        reconnectTimer = setTimeout(async () => {
            try {
                const current = playlist[trackIndex];
                if (current) revokePrepared(current.id);

                if (retryCount === 0) {
                    retryCount = 1;
                    await playCurrentTrack();
                } else if (retryCount === 1) {
                    retryCount = 2;
                    await loadPlaylist({ autoplay: true, preserveIndex: true });
                } else {
                    await nextSong();
                }
            } catch (error) {
                console.error(error);
                retryOrSkip();
            }
        }, 1800);
    }

    function scheduleStallRecovery() {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            if (shouldPlay && !intentionalSourceChange && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
                setConnection("error", "Áudio parado — a recuperar…");
                retryOrSkip();
            }
        }, 12000);
    }

    async function fetchStatus() {
        try {
            const response = await fetch(apiUrl("/api/status"), { cache: "no-store" });
            const status = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(status.error || `HTTP ${response.status}`);

            serverStatus.textContent = "Vercel online";
            if (!shouldPlay) qualityStatus.textContent = "MP3 pré-carregado";
            lisbonClock.textContent = formatClock(status.server_time);
            nextProgram.textContent = status.next_program
                ? `${status.next_program.start} — ${status.next_program.name}`
                : "—";
            countdown.textContent = formatDuration(status.program.seconds_remaining);
            listenerCount.textContent = shouldPlay ? "player ligado" : "player disponível";
            autoModeBtn.classList.toggle("active", status.mode === "auto");

            scheduleItems.forEach(item => {
                item.classList.toggle(
                    "current",
                    item.dataset.folder === status.program.folder &&
                    item.dataset.name === status.program.name,
                );
            });

            if (currentFolder && status.program.folder !== currentFolder) {
                trackIndex = 0;
                await loadPlaylist({ autoplay: shouldPlay });
            } else if (!currentFolder) {
                await loadPlaylist({ autoplay: false });
            }
        } catch (error) {
            console.error(error);
            serverStatus.textContent = "Sem resposta";
        }
    }

    powerBtn.addEventListener("click", () => {
        if (shouldPlay) stopRadio();
        else startRadio();
    });

    reconnectBtn.addEventListener("click", async () => {
        try {
            if (!shouldPlay) await startRadio();
            else {
                const current = playlist[trackIndex];
                if (current) revokePrepared(current.id);
                await playCurrentTrack();
            }
            showToast("Player reconectado.");
        } catch (error) {
            showToast(error.message || "Falha ao reconectar.", true);
        }
    });

    muteBtn.addEventListener("click", () => {
        audio.muted = !audio.muted;
        muteIcon.textContent = audio.muted ? "🔇" : "🔊";
    });

    volumeSlider.addEventListener("input", () => {
        audio.volume = Number(volumeSlider.value);
        audio.muted = false;
        muteIcon.textContent = "🔊";
        paintVolume();
        saveLocalState();
    });

    audio.addEventListener("playing", () => {
        clearTimeout(reconnectTimer);
        clearTimeout(stallTimer);
        retryCount = 0;
        setConnection("online", "Música reproduzida a partir do buffer local");
        qualityStatus.textContent = "MP3 local estável";

        if (pendingTrack) {
            showCurrentTrack(pendingTrack);
            pendingTrack = null;
        }

        preloadNextTrack();
    });

    audio.addEventListener("canplay", () => {
        if (shouldPlay && !audio.paused) setConnection("online", "Música em reprodução");
    });

    audio.addEventListener("ended", () => {
        if (shouldPlay) nextSong().catch(retryOrSkip);
    });

    audio.addEventListener("waiting", () => {
        if (shouldPlay) {
            setConnection("connecting", "A iniciar o áudio local…");
            scheduleStallRecovery();
        }
    });

    audio.addEventListener("stalled", () => {
        if (shouldPlay && !intentionalSourceChange) {
            setConnection("connecting", "Áudio local momentaneamente parado…");
            scheduleStallRecovery();
        }
    });

    audio.addEventListener("error", () => {
        if (shouldPlay && !intentionalSourceChange) {
            setConnection("error", "Erro no áudio — a recuperar…");
            retryOrSkip();
        }
    });

    autoModeBtn.addEventListener("click", async () => {
        try {
            manualProgram = null;
            trackIndex = 0;
            saveLocalState();
            await loadPlaylist({ autoplay: shouldPlay });
            await fetchStatus();
            showToast("Modo automático ativado.");
        } catch (error) {
            showToast(error.message, true);
        }
    });

    scheduleItems.forEach(item => {
        item.addEventListener("click", async () => {
            try {
                manualProgram = {
                    folder: item.dataset.folder,
                    name: item.dataset.name,
                };
                trackIndex = 0;
                saveLocalState();
                await loadPlaylist({ autoplay: shouldPlay });
                await fetchStatus();
                showToast(`Modo manual: ${item.dataset.name}`);
            } catch (error) {
                showToast(error.message, true);
            }
        });
    });

    window.addEventListener("beforeunload", () => {
        saveLocalState();
        abortDownloads();
        clearPrepared();
    });

    window.addEventListener("storage", event => {
        if (event.key !== STORAGE_KEY || !event.newValue) return;
        try {
            const incoming = JSON.parse(event.newValue);
            history = normaliseHistory(incoming.history);
            const incomingManual = normaliseManualProgram(incoming.manualProgram);
            const modeChanged = JSON.stringify(incomingManual) !== JSON.stringify(manualProgram);
            manualProgram = incomingManual;

            if (Number.isFinite(Number(incoming.volume))) {
                audio.volume = clamp(Number(incoming.volume), 0.05, 1);
                volumeSlider.value = String(audio.volume);
                paintVolume();
            }

            renderHistory();
            if (modeChanged) {
                trackIndex = 0;
                loadPlaylist({ autoplay: shouldPlay }).catch(console.error);
            }
        } catch (error) {
            console.warn("Estado recebido do LocalStorage inválido:", error);
        }
    });

    paintVolume();
    drawSpectrum();
    renderHistory();
    removeLegacyServiceWorkers();
    fetchStatus();
    setInterval(fetchStatus, 10000);
})();
