import { describe, expect, it } from "vitest";
import type { WireRelease, WireReleasesPayload } from "@/lib/native";
import {
  formatSpeed,
  humanSize,
  nextDownloadProgress,
  percentOf,
  releaseNotice,
  releaseRows,
} from "./releases";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function release(overrides: Partial<WireRelease> = {}): WireRelease {
  return {
    id: 1,
    tagName: "v1.2.0",
    name: "Release 1.2.0",
    body: "Notes",
    draft: false,
    prerelease: false,
    createdAt: "2026-10-20T12:00:00Z",
    publishedAt: "2026-10-20T12:30:00Z",
    htmlUrl: "https://github.com/me/app/releases/tag/v1.2.0",
    assets: [
      {
        id: 10,
        name: "app-setup.exe",
        size: 5 * 1024 * 1024,
        downloadCount: 3,
        contentType: "application/octet-stream",
        updatedAt: "2026-10-20T12:31:00Z",
      },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<WireReleasesPayload> = {}): WireReleasesPayload {
  return {
    kind: "ready",
    repo: "me/app",
    releases: [release()],
    error: null,
    ...overrides,
  };
}

describe("humanSize", () => {
  it("keeps bytes below one KiB as bytes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(1023)).toBe("1023 B");
  });

  it("uses binary units with one decimal", () => {
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanSize(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("percentOf", () => {
  it("returns a clamped percentage when the total is known", () => {
    expect(percentOf(0, 100)).toBe(0);
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(150, 100)).toBe(100);
    expect(percentOf(-1, 100)).toBe(0);
  });

  it("returns null when there is no total to divide by", () => {
    expect(percentOf(10, 0)).toBeNull();
  });
});

describe("formatSpeed", () => {
  it("formats bytes per second with the size units", () => {
    expect(formatSpeed(1024)).toBe("1.0 KB/s");
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
  });

  it("shows nothing before the first sample or for a broken value", () => {
    expect(formatSpeed(0)).toBeNull();
    expect(formatSpeed(Number.NaN)).toBeNull();
    expect(formatSpeed(-5)).toBeNull();
  });
});

describe("nextDownloadProgress", () => {
  it("starts with a sample and no speed", () => {
    expect(nextDownloadProgress(undefined, 1024, 2048, 1000)).toEqual({
      written: 1024,
      total: 2048,
      speed: 0,
      sampledAt: 1000,
      sampledWritten: 1024,
    });
  });

  it("measures speed once the sample is old enough", () => {
    const first = nextDownloadProgress(undefined, 1024, 2048, 1000);
    const second = nextDownloadProgress(first, 2048, 2048, 2000);
    expect(second.speed).toBe(1024);
    expect(second.sampledAt).toBe(2000);
    expect(second.sampledWritten).toBe(2048);
  });

  it("keeps the previous speed while samples arrive too fast", () => {
    const first = nextDownloadProgress(undefined, 1024, 2048, 1000);
    const measured = nextDownloadProgress(first, 2048, 2048, 2000);
    const tooSoon = nextDownloadProgress(measured, 2560, 4096, 2100);
    expect(tooSoon.speed).toBe(measured.speed);
    expect(tooSoon.sampledAt).toBe(2000);
    expect(tooSoon.written).toBe(2560);
  });

  it("smooths speed changes instead of jumping", () => {
    const first = nextDownloadProgress(undefined, 1024, 4096, 1000);
    const measured = nextDownloadProgress(first, 2048, 4096, 2000);
    const faster = nextDownloadProgress(measured, 5120, 8192, 3000);
    expect(measured.speed).toBe(1024);
    expect(faster.speed).toBeCloseTo(1638.4);
  });
});

describe("releaseRows", () => {
  it("maps a release and its assets for the list", () => {
    const rows = releaseRows(payload(), NOW, "zh");
    expect(rows).toHaveLength(1);
    expect(rows[0].tagName).toBe("v1.2.0");
    expect(rows[0].name).toBe("Release 1.2.0");
    expect(rows[0].body).toBe("Notes");
    expect(rows[0].draft).toBe(false);
    expect(rows[0].prerelease).toBe(false);
    expect(rows[0].when).toBe("23 小时前");
    expect(rows[0].assets).toEqual([
      {
        id: 10,
        name: "app-setup.exe",
        size: 5 * 1024 * 1024,
        sizeLabel: "5.0 MB",
        downloadCount: 3,
        contentType: "application/octet-stream",
        updatedAt: "2026-10-20T12:31:00Z",
      },
    ]);
  });

  it("falls back to the tag when the release has no name", () => {
    const rows = releaseRows(payload({ releases: [release({ name: "" })] }), NOW, "zh");
    expect(rows[0].name).toBe("v1.2.0");
  });

  // The edit form is seeded from `title`, which is what GitHub stores: with a title
  // saved it is also the display name, and with no title the list falls back to the
  // tag while the form must still open empty.
  it("keeps the stored title apart from the display name", () => {
    const stored = releaseRows(payload(), NOW, "zh");
    expect(stored[0].title).toBe("Release 1.2.0");
    expect(stored[0].name).toBe("Release 1.2.0");

    const untitled = releaseRows(
      payload({ releases: [release({ name: "" })] }),
      NOW,
      "zh",
    );
    expect(untitled[0].title).toBe("");
    expect(untitled[0].name).toBe("v1.2.0");
  });

  // Untrimmed on purpose: saving the form must not silently rewrite the stored title.
  it("carries the stored title through without trimming it", () => {
    const rows = releaseRows(
      payload({ releases: [release({ name: "  Release 1.2.0  " })] }),
      NOW,
      "zh",
    );
    expect(rows[0].title).toBe("  Release 1.2.0  ");
    expect(rows[0].name).toBe("Release 1.2.0");
  });

  // The release time follows the UI language: an English UI must not get Chinese.
  it("words the release time in English when asked for English", () => {
    const rows = releaseRows(payload(), NOW, "en");
    expect(rows[0].when).toBe("23 h ago");
  });

  it("uses the publish time and leaves it null when neither date parses", () => {
    const rows = releaseRows(
      payload({
        releases: [
          release(),
          release({
            id: 2,
            createdAt: "not a date",
            publishedAt: null,
          }),
        ],
      }),
      NOW,
      "zh",
    );
    expect(rows[0].when).toBe("23 小时前");
    expect(rows[1].when).toBeNull();
  });

  it("keeps draft and prerelease markers", () => {
    const rows = releaseRows(
      payload({ releases: [release({ draft: true, prerelease: true })] }),
      NOW,
      "zh",
    );
    expect(rows[0].draft).toBe(true);
    expect(rows[0].prerelease).toBe(true);
  });
});

describe("releaseNotice", () => {
  it("explains a missing gh instead of showing an empty list", () => {
    const notice = releaseNotice(
      payload({ kind: "notInstalled", releases: [], error: null }),
    );
    expect(notice).toMatchObject({
      tone: "warn",
      titleKey: "remotes.releases.notInstalled.title",
      detail: null,
    });
  });

  it("explains an unauthenticated gh", () => {
    expect(
      releaseNotice(payload({ kind: "notLoggedIn", releases: [] })),
    ).toMatchObject({
      tone: "warn",
      titleKey: "remotes.releases.notLoggedIn.title",
    });
  });

  it("keeps gh's own words for other failures", () => {
    expect(
      releaseNotice(payload({ kind: "error", releases: [], error: "rate limited" })),
    ).toMatchObject({
      tone: "error",
      detail: "rate limited",
    });
  });

  it("says the repo has no releases only when that was actually read", () => {
    expect(releaseNotice(payload({ releases: [] }))).toMatchObject({
      tone: "empty",
      titleKey: "remotes.releases.empty.title",
    });
  });

  it("draws the list when there is something to show", () => {
    expect(releaseNotice(payload())).toBeNull();
  });
});
