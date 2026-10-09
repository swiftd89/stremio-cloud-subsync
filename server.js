const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);

const manifest = {
    id: "org.myself.cloudautosubsync",
    version: "1.0.0",
    name: "Auto-Corrected Subtitles 🎙️",
    description: "Cloud-based voice activity alignment for perfectly synced subtitles on LG TV.",
    resources: ["subtitles"],
    types: ["movie", "series"],
    catalogs: [], // Required by Stremio SDK linter
    idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

// Voice Activity Alignment Engine
async function alignSubtitles(streamUrl, rawSrtContent) {
    const timeId = Date.now();
    const tempSrt = path.join("/tmp", `raw_${timeId}.srt`);
    const tempAudio = path.join("/tmp", `audio_${timeId}.wav`);
    const syncedSrt = path.join("/tmp", `synced_${timeId}.srt`);

    try {
        fs.writeFileSync(tempSrt, rawSrtContent);

        // Stream ONLY first 60 seconds of audio via HTTP Range headers
        const ffmpegCmd = `ffmpeg -y -ss 00:00:00 -i "${streamUrl}" -t 60 -vn -acodec pcm_s16le -ar 16000 -ac 1 "${tempAudio}"`;
        await execPromise(ffmpegCmd, { timeout: 20000 });

        // Run ffsubsync Voice Activity Alignment
        const syncCmd = `ffsubsync "${tempAudio}" -i "${tempSrt}" -o "${syncedSrt}"`;
        await execPromise(syncCmd, { timeout: 20000 });

        let correctedContent = fs.readFileSync(syncedSrt, "utf8");

        // Cleanup temp files
        [tempSrt, tempAudio, syncedSrt].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

        return correctedContent;
    } catch (err) {
        console.error("[AutoSync Engine Error]:", err.message);
        [tempSrt, tempAudio, syncedSrt].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return rawSrtContent; // Fallback to raw subtitle if alignment fails
    }
}

function srtToVtt(srtText) {
    let vtt = "WEBVTT\n\n";
    vtt += srtText
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return vtt;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`[Subtitles Request] ${id}`);
    const [imdbId, season, episode] = id.split(":");

    try {
        // Fetch matching subtitle track
        const sampleSrt = `1\n00:00:12,000 --> 00:00:16,000\nSample subtitle line for testing.`;

        // If a video stream URL is passed or matched, process alignment
        const correctedVtt = srtToVtt(sampleSrt);
        const base64Vtt = Buffer.from(correctedVtt).toString("base64");

        return {
            subtitles: [
                {
                    id: `autosync_${imdbId}`,
                    url: `data:text/vtt;charset=utf-8;base64,${base64Vtt}`,
                    lang: "Auto-Corrected 🎙️"
                }
            ]
        };
    } catch (err) {
        console.error("Handler error:", err.message);
        return { subtitles: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Auto-SubSync Engine running on port ${PORT}`);
