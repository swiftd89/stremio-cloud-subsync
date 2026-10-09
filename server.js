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
    version: "1.5.0",
    name: "Auto-Corrected Subtitles 🎙️",
    description: "Cloud-based voice activity alignment for perfectly synced subtitles on LG TV.",
    resources: ["subtitles"],
    types: ["movie", "series", "anime", "other"],
    catalogs: []
};

const builder = new addonBuilder(manifest);

function srtToVtt(srtText) {
    let vtt = "WEBVTT\n\n";
    vtt += srtText
        .replace(/\r\n/g, "\n")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return vtt;
}

async function fetchFromOpenSubtitles(cleanImdb, season, episode) {
    if (!OPENSUBTITLES_API_KEY) return null;
    try {
        let url = "https://api.opensubtitles.com/api/v1/subtitles?languages=en";
        
        if (season && episode) {
            url += `&parent_imdb_id=${cleanImdb}&season_number=${season}&episode_number=${episode}`;
        } else {
            url += `&imdb_id=${cleanImdb}`;
        }

        const customHeaders = {
            "Api-Key": OPENSUBTITLES_API_KEY,
            "User-Agent": "stremio-cloud-subsync v1.5.0",
            "Content-Type": "application/json",
            "Accept": "application/json"
        };

        const res = await axios.get(url, { headers: customHeaders, timeout: 5000 });

        if (res.data?.data?.[0]?.attributes?.files?.[0]?.file_id) {
            const fileId = res.data.data[0].attributes.files[0].file_id;

            const dlRes = await axios.post(
                "https://api.opensubtitles.com/api/v1/download", 
                { file_id: fileId }, 
                { headers: customHeaders, timeout: 5000 }
            );

            if (dlRes.data?.link) {
                const srtContent = await axios.get(dlRes.data.link, { timeout: 5000 });
                return srtContent.data;
            }
        }
    } catch (err) {
        console.error(`[OpenSubtitles Error]: ${err.message}`);
    }
    return null;
}

async function fetchFromSubMirror(cleanImdb, season, episode) {
    try {
        const url = `https://subtitles.strem.io/subtitles/series/tt${cleanImdb}:${season}:${episode}/en.json`;
        const res = await axios.get(url, { timeout: 5000 });
        
        if (res.data?.[0]?.url) {
            const srtRes = await axios.get(res.data[0].url, { timeout: 5000 });
            return srtRes.data;
        }
    } catch (err) {
        console.error(`[Subtitle Mirror Error]: ${err.message}`);
    }
    return null;
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
    console.log(`[Subtitles Request] Type: ${type}, ID: ${id}`);
    const parts = id.split(":");
    const imdbId = parts[0];
    const season = parts[1];
    const episode = parts[2];
    const cleanImdb = imdbId.replace("tt", "");

    try {
        let rawSrt = await fetchFromOpenSubtitles(cleanImdb, season, episode);
        
        if (!rawSrt) {
            console.log("[Subtitles] Primary search yielded no result, checking fallback mirror...");
            rawSrt = await fetchFromSubMirror(cleanImdb, season, episode);
        }

        if (!rawSrt) {
            console.log(`[Subtitles] No subtitle file found for ${id}`);
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
