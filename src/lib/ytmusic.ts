import YTMusic from "ytmusic-api";

let ytmusic: YTMusic | null = null;

export async function getYTMusic(): Promise<YTMusic> {
  if (ytmusic) return ytmusic;
  ytmusic = new YTMusic();
  const cookie = process.env.YT_COOKIES || "";
  await ytmusic.initialize({ cookies: cookie || undefined });
  return ytmusic;
}

export function resetYTMusic() {
  ytmusic = null;
}

function parseDuration(text: string): number {
  const parts = text.trim().split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

const SONG_SEARCH_PARAMS = "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D";

export async function searchSongsWithRealVideoIds(q: string) {
  const yt = await getYTMusic();

  const rawData = await (yt as any).constructRequest("search", {
    query: q,
    params: SONG_SEARCH_PARAMS,
  });

  const items: any[] = [];

  function walkTree(obj: any) {
    if (!obj || typeof obj !== "object") return;
    if (obj.musicResponsiveListItemRenderer) {
      items.push(obj.musicResponsiveListItemRenderer);
    }
    for (const val of Object.values(obj)) {
      if (typeof val === "object") walkTree(val);
    }
  }
  walkTree(rawData);

  const tracks = items.map((item) => {
    const flexColumns = item?.flexColumns ?? [];
    const runs = flexColumns
      .map((fc: any) => fc?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
      .flat();

    const title = runs[0];

    const artist = runs.find((r: any) => {
      const pageType = r?.navigationEndpoint?.browseEndpoint
        ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      return pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL" || pageType === "MUSIC_PAGE_TYPE_ARTIST";
    }) || runs[3];

    const album = runs.find((r: any) => {
      const pageType = r?.navigationEndpoint?.browseEndpoint
        ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      return pageType === "MUSIC_PAGE_TYPE_ALBUM";
    });

    const durationRun = runs.find((r: any) =>
      /(\d{1,2}:)?\d{1,2}:\d{2}/.test(r?.text ?? ""),
    );

    const navEndpoint = item?.menu?.menuRenderer?.items?.[0]
      ?.menuNavigationItemRenderer?.navigationEndpoint;
    const videoId = navEndpoint?.watchEndpoint?.videoId ?? "";

    const thumbs = item?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];

    return {
      videoId,
      name: title?.text ?? "",
      artist: {
        name: artist?.text ?? "",
        artistId: artist?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
      },
      album: album
        ? {
            name: album.text ?? "",
            albumId: album?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
          }
        : null,
      duration: parseDuration(durationRun?.text ?? ""),
      thumbnails: thumbs,
    };
  });

  return tracks;
}
