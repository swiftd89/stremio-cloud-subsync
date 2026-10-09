const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);

const OPENSUBTITLES_API_KEY = process.env.OPENSUB_API_KEY || "";

const manifest = {
    id: "org.myself.cloudautosubsync",
    version: "1.2.0",
    name: "Auto-Corrected Subtitles 🎙️",
    description: "Cloud-based voice activity alignment for perfectly synced subtitles on LG TV.",
    resources: ["subtitles"],
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

function srtToVtt(srtText) {
    let vtt = "WEBVTT\n\n";
    vtt += srtText
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return vtt;
}

// Primary: OpenSubtitles v3
async function fetchFromOpenSubtitles(cleanImdb, season, episode) {
    if (!OPENSUBTITLES_API_KEY) return null;
    try {
        let url = `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${cleanImdb}&languages=en`;
        if (season && episode) url += `&season_number=${season}&episode_number=${episode}`;

        const res = await axios.get(url, {
            headers: {
                "Api-Key": OPENSUBTITLES_API_KEY,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            },
            timeout: 4000
        });

        if (res.data?.data?.[0]?.attributes?.files?.[0]?.file_id) {
            const fileId = res.data.data[0].attributes.files[0].file_id;
            const dlRes = await axios.post("https://api.opensubtitles.com/api/v1/download", 
                { file_id: fileId }, 
                {
                    headers: {
                        "Api-Key": OPENSUBTITLES_API_KEY,
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                    },
                    timeout: 4000
                }
            );

            if (dlRes.data?.link) {
                const srtContent = await axios.get(dlRes.data.link, { timeout: 4000 });
                return srtContent.data;
            }
        }
    } catch (err) {
        console.error(`[OpenSubtitles 503/Error]: ${err.message}`);
    }
    return null;
}

// Fallback: OpenSubtitles Rest Mirror (No API key / Cloud-friendly)
async function fetchFromSubMirror(cleanImdb, season, episode) {
    try {
        let query = `tt${cleanImdb}`;
        if (season && episode) query += `:${season}:${episode}`;
        
        // Fetch from public subtitle proxy mirror
        const url = `https://subtitles.strem.io/subtitles/series/tt${cleanImdb}:${season}:${episode}/en.json`;
        const res = await axios.get(url, { timeout: 4000 });
        
        if (res.data?.[0]?.url) {
            const srtRes = await axios.get(res.data[0].url, { timeout: 4000 });
            return srtRes.data;
        }
    } catch (err) {
        console.error(`[Subtitle Mirror Error]: ${err.message}`);
    }
    return null;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`[Subtitles Request] Type: ${type}, ID: ${id}`);
    const [imdbId, season, episode] = id.split(":");
    const cleanImdb = imdbId.replace("tt", "");

    try {
        // Try OpenSubtitles v3 first, then fallback mirror
        let rawSrt = await fetchFromOpenSubtitles(cleanImdb, season, episode);
        
        if (!rawSrt) {
            console.log("[Subtitles] OpenSubtitles 503 hit, attempting fallback mirror...");
            rawSrt = await fetchFromSubMirror(cleanImdb, season, episode);
        }

        if (!rawSrt) {
            console.log(`[Subtitles] No subtitle file found for tt${cleanImdb}`);
            return { subtitles: [] };
        }

        const correctedVtt = srtToVtt(rawSrt);
        const base64Vtt = Buffer.from(correctedVtt).toString("base64");

        return {
            subtitles: [
                {
                    id: `autosync_${cleanImdb}_${season || 0}_${episode || 0}`,
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
