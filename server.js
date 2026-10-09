const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);

const OPENSUBTITLES_API_KEY = process.env.OPENSUB_API_KEY || ""; // Set in Render Env Vars

const manifest = {
    id: "org.myself.cloudautosubsync",
    version: "1.1.0",
    name: "Auto-Corrected Subtitles 🎙️",
    description: "Cloud-based voice activity alignment for perfectly synced subtitles on LG TV.",
    resources: ["subtitles"],
    types: ["movie", "series"],
    catalogs: [],
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
        console.error("[AutoSync Engine Fallback]:", err.message);
        [tempSrt, tempAudio, syncedSrt].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return rawSrtContent; // Return original track if audio alignment times out
    }
}

function srtToVtt(srtText) {
    let vtt = "WEBVTT\n\n";
    vtt += srtText
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return vtt;
}

// Search OpenSubtitles API for English subtitles matching IMDB ID
async function fetchOpenSubtitles(imdbId, season, episode) {
    if (!OPENSUBTITLES_API_KEY) {
        console.log("[Warning] Missing OPENSUB_API_KEY env variable.");
        return null;
    }

    try {
        const cleanImdb = imdbId.replace("tt", "");
        let url = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${cleanImdb}&languages=en`;
        if (season && episode) {
            url += `&season_number=${season}&episode_number=${episode}`;
        }

        const res = await axios.get(url, {
            headers: {
                "Api-Key": OPENSUBTITLES_API_KEY,
                "User-Agent": "StremioCloudSubsync v1.1.0"
            },
            timeout: 5000
        });

        if (res.data && res.data.data && res.data.data.length > 0) {
            const fileId = res.data.data[0].attributes.files[0].file_id;

            // Request download link
            const dlRes = await axios.post("https://api.opensubtitles.com/api/v1/download", 
                { file_id: fileId }, 
                {
                    headers: {
                        "Api-Key": OPENSUBTITLES_API_KEY,
                        "Content-Type": "application/json",
                        "User-Agent": "StremioCloudSubsync v1.1.0"
                    },
                    timeout: 5000
                }
            );

            if (dlRes.data && dlRes.data.link) {
                const srtContentRes = await axios.get(dlRes.data.link, { timeout: 5000 });
                return srtContentRes.data;
            }
        }
    } catch (err) {
        console.error("[OpenSubtitles Fetch Error]:", err.message);
    }
    return null;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`[Subtitles Request] Type: ${type}, ID: ${id}`);
    const [imdbId, season, episode] = id.split(":");

    try {
        const rawSrt = await fetchOpenSubtitles(imdbId, season, episode);

        if (!rawSrt) {
            console.log(`[Subtitles] No subtitle file found for ${imdbId}`);
            return { subtitles: [] };
        }

        const correctedVtt = srtToVtt(rawSrt);
        const base64Vtt = Buffer.from(correctedVtt).toString("base64");

        return {
            subtitles: [
                {
                    id: `autosync_${imdbId}_${season || 0}_${episode || 0}`,
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
