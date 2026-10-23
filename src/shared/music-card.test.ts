import { expect, it } from "vitest";
import { normalizeMusicCardData } from "./music-card";

it("filters unusable songs without sorting the remaining recommendations", () => {
  const output = normalizeMusicCardData({
    source: "daily_recommendation", setId: "morning-playlist",
    tracks: [
      { id: "zeta", name: "Harbor", artists: ["Quartet"] },
      { id: "", name: "Missing catalog ID", artists: [] },
      { id: "alpha", name: "Lanterns", artists: ["Ensemble"] },
    ],
  });
  expect(output?.tracks.map(song => song.id)).toStrictEqual(["zeta", "alpha"]);
});

it("takes exactly the first five valid search results", () => {
  const tracks = Array.from({ length: 9 }, (_, i) => ({ id: `catalog-${i}`, name: `Composition ${i}`, artists: ["Soloist"] }));
  expect(normalizeMusicCardData({ source: "search", setId: "evening-search", tracks })?.tracks)
    .toStrictEqual(tracks.slice(0, 5).map(track => ({ ...track, album: undefined, coverUrl: undefined })));
});

it.each([null, {}, { setId: "x", source: "other", tracks: [] }, { setId: "x", source: "search", tracks: [] }])(
  "rejects a card without valid metadata or songs: %j", value => {
    expect(normalizeMusicCardData(value)).toBeNull();
  },
);