const axios = require("axios");
const common = require("./commonClient");

// --- Constants ---
const HEADER_JELLYFIN_TOKEN = 'X-MediaBrowser-Token';
const ITEM_TYPE_MOVIE = common.ITEM_TYPE_MOVIE;
const ITEM_TYPE_EPISODE = common.ITEM_TYPE_EPISODE;
const ITEM_TYPE_SERIES = common.ITEM_TYPE_SERIES;
const DEFAULT_FIELDS = common.DEFAULT_FIELDS;
const CODEC_FORMAT_MAP = common.CODEC_FORMAT_MAP;

// --- Jellyfin Item Finding ---

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 300;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);
const RETRYABLE_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "ERR_NETWORK"]);

/**
 * Performs a Jellyfin API request with standard headers, timeout, and retry on transient failures.
 * @param {string} url - The full URL for the API request.
 * @param {object} [params] - Optional query parameters.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<object|null>} The response data object or null if an error occurs.
 */
async function makeApiRequest(url, params = {}, config) {
    let lastErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                headers: { [HEADER_JELLYFIN_TOKEN]: config.accessToken },
                params: params,
                timeout: 5000
            });
            return response.data;
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            const code = err.code;
            const isRetryable = RETRYABLE_STATUS_CODES.has(status) || RETRYABLE_ERROR_CODES.has(code);

            if (isRetryable && attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            break;
        }
    }

    const sanitizedUrl = url.replace(/https?:\/\/[^\/\s:]+(?::\d+)?/, '[SERVER]');
    const sanitizedParams = { ...params };
    if (sanitizedParams.UserId) delete sanitizedParams.UserId;

    console.warn(`⚠️ API Request failed for ${sanitizedUrl} with params ${JSON.stringify(sanitizedParams)}:`, lastErr.message);

    if (lastErr.response?.status === 401) {
         console.log("🔧 Detected Unauthorized (401). The provided access token might be invalid or expired.");
    }
    return null;
}

/**
 * Attempts to find a movie item in Jellyfin using various strategies.
 * @param {string|null} imdbId - The IMDb ID to search for.
 * @param {string|null} tmdbId - The TMDb ID to search for.
 * @param {string|null} tvdbId - The TVDB ID to search for.
 * @param {string|null} anidbId - The AniDB ID to search for.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<Array<object>>} Array of found Jellyfin movie items.
 */
async function findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    let foundItems = [];
    const baseMovieParams = {
        IncludeItemTypes: ITEM_TYPE_MOVIE,
        Recursive: true,
        Fields: DEFAULT_FIELDS,
        Limit: 10, // Limit results per query
        Filters: "IsNotFolder", // Important filter for movies
        UserId: config.userId
    };

    // --- Strategy 1: Direct ID Lookup (/Items) ---
    const directLookupParams = { ...baseMovieParams };
    let searchedIdField = "";
    if (imdbId) { directLookupParams.ImdbId = imdbId; searchedIdField = "ImdbId"; }
    else if (tmdbId) { directLookupParams.TmdbId = tmdbId; searchedIdField = "TmdbId"; }
    else if (tvdbId) { directLookupParams.TvdbId = tvdbId; searchedIdField = "TvdbId"; }
    else if (anidbId) { directLookupParams.AniDbId = anidbId; searchedIdField = "AniDbId"; }
    if (searchedIdField) {
        const data = await makeApiRequest(`${config.serverUrl}/Items`, directLookupParams, config);
        if (data?.Items?.length > 0) {
            const matches = data.Items.filter(i => common._isMatchingProviderId(i.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
            if (matches.length > 0) {
                foundItems.push(...matches);
            }
        }
    }

    // --- Strategy 2: AnyProviderIdEquals Lookup (/Users/{UserId}/Items) ---
    if (foundItems.length === 0) {
        const anyProviderIdFormats = [];
        if (imdbId) {
            const numericImdbId = imdbId.replace('tt', '');
            anyProviderIdFormats.push(`imdb.${imdbId}`, `Imdb.${imdbId}`);
            if (numericImdbId !== imdbId) anyProviderIdFormats.push(`imdb.${numericImdbId}`, `Imdb.${numericImdbId}`);
        } else if (tmdbId) {
            anyProviderIdFormats.push(`tmdb.${tmdbId}`, `Tmdb.${tmdbId}`);
        } else if (tvdbId) {
            anyProviderIdFormats.push(`tvdb.${tvdbId}`, `Tvdb.${tvdbId}`);
        } else if (anidbId) {
            anyProviderIdFormats.push(`anidb.${anidbId}`, `AniDb.${anidbId}`);
        }

        const results = await Promise.allSettled(anyProviderIdFormats.map(attemptFormat => {
            const altParams = { ...baseMovieParams, AnyProviderIdEquals: attemptFormat };
            delete altParams.ImdbId;
            delete altParams.TmdbId;
            delete altParams.TvdbId;
            delete altParams.AniDbId;
            delete altParams.UserId;
            return makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, altParams, config);
        }));

        for (const result of results) {
            if (result.status === "fulfilled" && result.value?.Items?.length > 0) {
                const matches = result.value.Items.filter(i => common._isMatchingProviderId(i.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
                if (matches.length > 0) {
                    foundItems.push(...matches);
                }
            }
        }
    }

    return foundItems;
}

/**
 * Attempts to find a series item in Jellyfin.
 * @param {string|null} imdbId - The IMDb ID of the series.
 * @param {string|null} tmdbId - The TMDb ID of the series.
 * @param {string|null} tvdbId - The TVDB ID of the series.
 * @param {string|null} anidbId - The AniDB ID of the series.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<Array<object>>} Array of found Jellyfin series items.
 */
async function findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    let foundSeries = [];
    const baseSeriesParams = {
        IncludeItemTypes: ITEM_TYPE_SERIES,
        Recursive: true,
        Fields: "ProviderIds,Name,Id", // Only need these fields for series lookup
        Limit: 5
    };

    // --- Strategy 1: Direct ID Lookup (/Users/{UserId}/Items) ---
    const seriesLookupParams1 = { ...baseSeriesParams };
    if (imdbId) seriesLookupParams1.ImdbId = imdbId;
    else if (tmdbId) seriesLookupParams1.TmdbId = tmdbId;
    else if (tvdbId) seriesLookupParams1.TvdbId = tvdbId;
    else if (anidbId) seriesLookupParams1.AniDbId = anidbId;
    const data1 = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, seriesLookupParams1, config);
    if (data1?.Items?.length > 0) {
        const matches = data1.Items.filter(s => common._isMatchingProviderId(s.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
        if (matches.length > 0) {
            foundSeries.push(...matches);
        }
    }

    // --- Strategy 2: AnyProviderIdEquals Lookup (/Users/{UserId}/Items) ---
    if (foundSeries.length === 0) {
        let anyProviderIdValue = null;
        if (imdbId) anyProviderIdValue = `imdb.${imdbId}`;
        else if (tmdbId) anyProviderIdValue = `tmdb.${tmdbId}`;
        else if (tvdbId) anyProviderIdValue = `tvdb.${tvdbId}`;
        else if (anidbId) anyProviderIdValue = `anidb.${anidbId}`;
        if (anyProviderIdValue) {
            const seriesLookupParams2 = { ...baseSeriesParams, AnyProviderIdEquals: anyProviderIdValue };
            delete seriesLookupParams2.ImdbId; // Remove specific ID params
            delete seriesLookupParams2.TmdbId;
            delete seriesLookupParams2.TvdbId;
            delete seriesLookupParams2.AniDbId;
            const data2 = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, seriesLookupParams2, config);
            if (data2?.Items?.length > 0) {
                const matches = data2.Items.filter(s => common._isMatchingProviderId(s.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
                 if (matches.length > 0) {
                    foundSeries.push(...matches);
                }
            }
        }
    }

    return foundSeries;
}

/**
 * Finds a specific episode within a given series and season in Jellyfin.
 * @param {object} parentSeriesItem - The Jellyfin series item object (must have Id and Name).
 * @param {number} seasonNumber - The season number to look for.
 * @param {number} episodeNumber - The episode number to look for.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<object|null>} The found Jellyfin episode item or null.
 */
async function findEpisodeItem(parentSeriesItem, seasonNumber, episodeNumber, config) {
    const episodesParams = {
        Season: seasonNumber,
        UserId: config.userId,
        Fields: DEFAULT_FIELDS
    };
    const episodesData = await makeApiRequest(`${config.serverUrl}/Shows/${parentSeriesItem.Id}/Episodes`, episodesParams, config);

    if (!episodesData?.Items?.length > 0) {
        return null;
    }

    return episodesData.Items.find(ep => ep.IndexNumber === episodeNumber && ep.ParentIndexNumber === seasonNumber) || null;
}

/**
 * Gets playback information for a Jellyfin item and generates direct play stream URLs.
 * @param {object} item - The Jellyfin movie or episode item (must have Id, Name, Type).
 * @param {string|null} [seriesName=null] - Optional: The name of the series if item is an episode.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<Array<object>|null>} An array of stream detail objects or null if no suitable streams are found.
 */
async function getPlaybackStreams(item, seriesName = null, config) {
    
    const playbackInfoParams = { UserId: config.userId};
    const playbackInfoData = await makeApiRequest(
        `${config.serverUrl}/Items/${item.Id}/PlaybackInfo`,
        playbackInfoParams,
        config
    );

    if (!playbackInfoData?.MediaSources?.length > 0) {
        console.warn("❌ No MediaSources found for item:", item.Name, `(${item.Id})`);
        return null;
    }

    const streamDetailsArray = [];

    // Process ALL available MediaSources (multiple quality options)
    for (const source of playbackInfoData.MediaSources) {
        try {
            // Extract video stream (primary video track)
            const videoStream = source.MediaStreams?.find(ms => ms.Type === 'Video');
            
            // Extract audio stream (prefer default, fallback to first)
            const audioStream = source.MediaStreams?.find(ms => ms.Type === 'Audio' && ms.IsDefault)
                             || source.MediaStreams?.find(ms => ms.Type === 'Audio');
            
            // Extract subtitle streams
            const subtitleStreams = source.MediaStreams?.filter(ms => ms.Type === 'Subtitle') || [];
            
            // Build enriched media info object using safe extraction
            const mediaInfo = common.safeExtractMediaInfo(source, videoStream, audioStream);
            
            // Build comprehensive description string
            const streamDescription = common.buildStreamDescription(mediaInfo);
            
            // Build Quality Title (preserved for backward compatibility)
            let qualityTitle = "";
            if (videoStream) {
              qualityTitle += videoStream.DisplayTitle || "";
              if (videoStream.Width && videoStream.Height) {
                  if (!qualityTitle.toLowerCase().includes(videoStream.Height + "p") && !qualityTitle.toLowerCase().includes(videoStream.Width + "x" + videoStream.Height)) {
                      qualityTitle = (qualityTitle ? qualityTitle + " " : "") + `${videoStream.Height}p`;
                  }
              }
              if (videoStream.Codec) {
                  if (!qualityTitle.toLowerCase().includes(videoStream.Codec.toLowerCase())) {
                        qualityTitle = (qualityTitle ? qualityTitle + " " : "") + videoStream.Codec.toUpperCase();
                  }
              }
          } else if (source.Container) {
              qualityTitle = source.Container.toUpperCase();
          }
          if (source.Name && !qualityTitle) {
                qualityTitle = source.Name;
          }
          qualityTitle = qualityTitle || 'Direct Play'; // Fallback title

            // Construct direct play URL (Jellyfin format - same as Emby)
            const directPlayUrl = `${config.serverUrl}/Videos/${item.Id}/stream.${source.Container}?MediaSourceId=${source.Id}&Static=true&api_key=${config.accessToken}&DeviceId=stremio-addon-device-id`;
            
            // Format subtitles for Stremio
            const subtitles = subtitleStreams.map(sub => {
                const codec = sub.Codec?.toLowerCase();
                const format = CODEC_FORMAT_MAP[codec] || 'srt';
                
                return {
                    id: `sub-${item.Id}-${source.Id}-${sub.Index}`,
                    lang: sub.Language || 'und',  // Keep 3-letter ISO 639-2 code, fallback to 'und'
                    url: `${config.serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${format}?api_key=${config.accessToken}`
                };
            });
            
            // Add enriched stream details (preserve all existing fields for backward compatibility)
            streamDetailsArray.push({
                // Existing fields (preserved for backward compatibility)
                directPlayUrl: directPlayUrl,
                itemName: item.Name,
                seriesName: seriesName,
                seasonNumber: item.Type === ITEM_TYPE_EPISODE ? item.ParentIndexNumber : null,
                episodeNumber: item.Type === ITEM_TYPE_EPISODE ? item.IndexNumber : null,
                itemId: item.Id,
                mediaSourceId: source.Id,
                container: source.Container,
                videoCodec: videoStream?.Codec || source.VideoCodec || null,
                audioCodec: audioStream?.Codec || null,
                qualityTitle: qualityTitle,
                embyUrlBase: config.serverUrl, // Keep name for backward compatibility
                apiKey: config.accessToken,
                subtitles: subtitles,
                
                // New enriched fields
                streamDescription: streamDescription,
                mediaInfo: mediaInfo,
                audioLanguages: (source.MediaStreams || [])
                    .filter(ms => ms.Type === 'Audio' && ms.Language)
                    .map(ms => ms.Language.toLowerCase()),
                defaultAudioLanguage: audioStream?.Language?.toLowerCase() || null
            });
        } catch (error) {
            // SECURITY: Only log error message, not full error object
            console.error(`❌ Error processing MediaSource ${source.Id} for item ${item.Id}:`, error?.message || String(error));
            // Continue to next source instead of failing completely
            continue;
        }
    }

    if (streamDetailsArray.length === 0) {
        console.warn(`❌ No direct playable sources found for item: ${item.Name} (${item.Id})`);
        return null;
    }

    return streamDetailsArray;
}

// --- Main Exported Function ---

/**
 * Orchestrates the process of finding a Jellyfin item (movie or episode) based on
 * an external ID and returning direct play stream information, using provided configuration.
 * @param {string} idOrExternalId - The Stremio-style ID (e.g., "tt12345", "tmdb12345:1:2").
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<Array<object>|null>} An array of stream detail objects or null if unsuccessful.
 */
async function getStream(idOrExternalId, config) {
    
    // Validate provided configuration
    if (!config.serverUrl || !config.userId || !config.accessToken) {
        console.error("❌ Configuration missing (serverUrl, userId, or accessToken)");
        return null; // Critical configuration is missing
    }
    let fullIdForLog = idOrExternalId;
    try {
        // 1. Parse Input ID
        const parsedId = common.parseMediaId(idOrExternalId);
        if (parsedId) {
            fullIdForLog = parsedId.baseId + (parsedId.itemType === ITEM_TYPE_EPISODE ? ` S${parsedId.seasonNumber}E${parsedId.episodeNumber}` : '');
        }
        if (!parsedId) {
            console.error(`❌ Failed to parse input ID: ${idOrExternalId}`);
            return null;
        }

        // 2. Find the Jellyfin Item
        let item = null;
        let parentSeriesName = null;

        if (parsedId.itemType === ITEM_TYPE_MOVIE) {
            item = await findMovieItem(parsedId.imdbId, parsedId.tmdbId, parsedId.tvdbId, parsedId.anidbId, config);
        } else if (parsedId.itemType === ITEM_TYPE_EPISODE) {   
            const seriesItems = await findSeriesItem(parsedId.imdbId, parsedId.tmdbId, parsedId.tvdbId, parsedId.anidbId, config);
            if (seriesItems && seriesItems.length > 0) {
                const streamResults = await Promise.all(seriesItems.map(async (series) => {
                    const episode = await findEpisodeItem(series, parsedId.seasonNumber, parsedId.episodeNumber, config);
                    if (!episode) return null;
                    return getPlaybackStreams(episode, series.Name, config);
                }));
                const allStreams = streamResults.filter(Boolean).flat();
                if (allStreams.length > 0) {
                    return common.deduplicateAndSortStreams(allStreams, config.preferredLanguage);
                }
                return null;
            }
            return null;
        }

        // 3. Get Playback Streams if Item Found
        if (item && item.length > 0) {  
            const streamResults = await Promise.all(
                item.map(singleItem => getPlaybackStreams(singleItem, parentSeriesName, config))
            );
            const allStreams = streamResults.filter(Boolean).flat();
            return allStreams.length > 0 ? common.deduplicateAndSortStreams(allStreams, config.preferredLanguage) : null;
        }
        return null;

    } catch (err) {
        // SECURITY: Only log error message and stack, not full error object which might contain config
        console.error(`❌ Unhandled error in getStream for ID ${fullIdForLog}:`, err?.message || String(err));
        if (err?.stack && process.env.NODE_ENV === 'development') {
            console.error("Stack trace:", err.stack);
        }
        return null;
    } 
}

/**
 * Fetches the user's "Continue Watching" (resume) items from Jellyfin.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @param {string} type - The Stremio content type ("movie" or "series").
 * @param {number} [skip=0] - Number of items to skip for pagination.
 * @param {number} [limit=20] - Maximum number of items to return.
 * @returns {Promise<Array<object>|null>} Array of Stremio meta-preview objects or null on failure.
 */
async function getResumeItems(config, type, skip, limit) {
    const includeTypes = type === "series" ? "Episode" : "Movie";
    const fields = "ProviderIds,ImageTags,Overview,PrimaryImageAspectRatio,SeriesName,IndexNumber,ParentIndexNumber,ProductionYear";

    const data = await makeApiRequest(
        `${config.serverUrl}/Users/${config.userId}/Items/Resume`,
        {
            Limit: limit || 20,
            StartIndex: skip || 0,
            Fields: fields,
            IncludeItemTypes: includeTypes,
            MediaTypes: "Video",
            EnableImages: true,
            EnableUserData: true
        },
        config
    );

    if (!data?.Items?.length) return [];

    return data.Items.map(item => {
        const ids = item.ProviderIds || {};
        let stremioId = null;

        if (ids.Imdb || ids.imdb || ids.IMDB) {
            stremioId = ids.Imdb || ids.imdb || ids.IMDB;
        } else if (ids.Tmdb || ids.tmdb || ids.TMDB) {
            stremioId = `tmdb:${ids.Tmdb || ids.tmdb || ids.TMDB}`;
        } else if (ids.Tvdb || ids.tvdb || ids.TVDB) {
            stremioId = `tvdb:${ids.Tvdb || ids.tvdb || ids.TVDB}`;
        }

        if (!stremioId) return null;

        // For episodes, use the series' provider IDs for the Stremio meta ID
        if (item.Type === "Episode" && item.SeriesId) {
            // The resume endpoint returns episode-level items; Stremio catalogs
            // need series-level IDs. If ProviderIds are series-level, use them directly.
            // If they are episode-level, we still link — Stremio will resolve.
        }

        const tag = item.ImageTags?.Primary || item.PrimaryImageTag;
        const poster = tag
            ? `${config.serverUrl}/Items/${item.Id}/Images/Primary?tag=${tag}&maxHeight=450`
            : null;

        const meta = {
            id: stremioId,
            type: type,
            name: item.Type === "Episode"
                ? `${item.SeriesName || ""} S${item.ParentIndexNumber || 0}E${item.IndexNumber || 0}`
                : item.Name,
            poster: poster
        };

        if (item.ProductionYear) meta.releaseInfo = String(item.ProductionYear);
        if (item.Overview) meta.description = item.Overview;

        return meta;
    }).filter(Boolean);
}

// --- Exports ---
module.exports = {
    getStream,
    getResumeItems,
    parseMediaId: common.parseMediaId,
    deduplicateAndSortStreams: common.deduplicateAndSortStreams
};

