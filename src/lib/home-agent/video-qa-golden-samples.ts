export const VIDEO_QA_GOLDEN_SAMPLE_VERSION = "video-qa-golden-v1";

type GoldenSampleSection = {
  title: string;
  items: string[];
};

const REFERENCE_CHARACTER_SECTIONS: GoldenSampleSection[] = [
  {
    title: "Golden signals",
    items: [
      "The subject is fully visible, with a stable face, hairstyle, costume silhouette, and body language that can be recognized again later.",
      "Character identity anchors stay consistent: facial structure, costume layers, accessories, and hair design do not drift into another look.",
      "The framing feels reusable for production continuity rather than like a cropped poster, mood card, or one-off glamour shot.",
      "Lighting, materials, and era cues stay internally consistent so later shots can extend directly from this reference.",
    ],
  },
  {
    title: "Negative anchors",
    items: [
      "The face or hands collapse, costume layers mutate unexpectedly, or the hairstyle and color drift away from the requested identity.",
      "The subject is cropped too tightly, hiding the forehead, chin, shoulders, or other critical silhouette anchors needed for later reuse.",
      "Visible subtitles, logos, watermarks, or UI overlays should be logged as cleanup notes, but they are not blocking failures by themselves if the image is otherwise reusable.",
      "The rendering mode or era drifts suddenly, such as realistic modern drama turning into ancient costume fantasy, cel animation, or stylized illustration without permission.",
    ],
  },
  {
    title: "High-quality exemplar",
    items: [
      "A production-grade reference card: the character is clearly visible from the front or a readable three-quarter angle, costume layers are intact, and the image could immediately anchor later storyboards and identity locking.",
    ],
  },
];

const REFERENCE_SCENE_SECTIONS: GoldenSampleSection[] = [
  {
    title: "Golden signals",
    items: [
      "The spatial structure is readable, with stable foreground, midground, background, and primary lighting direction that can be reused in later shots.",
      "Era, materials, weather, and dominant color temperature stay consistent, with no sudden style or world drift.",
      "Key entrances, windows, pathways, light sources, and prop anchors are clear enough to support continuity blocking.",
      "The image feels like a stable set reference rather than a loose concept sketch or abstract mood board.",
    ],
  },
  {
    title: "Negative anchors",
    items: [
      "Spatial direction is confused, making it hard to tell where characters can enter, exit, or hand off camera motion.",
      "The key scene subject is blocked or cropped, and the major prop or geography anchors are not clear enough to sustain continuity.",
      "Visible subtitles, logos, watermarks, or UI overlays should be logged as cleanup notes, but they are not automatic failures when the space, era, and rendering style still match the project.",
      "Weather, lighting, material language, or historical cues drift so far that later shots could not plausibly stay in the same world.",
    ],
  },
  {
    title: "High-quality exemplar",
    items: [
      "A production-grade set reference: geometry, light direction, and primary visual anchors are readable at a glance, so a storyboard artist could immediately block later shots from it.",
    ],
  },
];

const SEGMENT_VIDEO_SECTIONS: GoldenSampleSection[] = [
  {
    title: "Golden signals",
    items: [
      "The opening frame naturally continues the prior segment's action, eyeline, space, or emotion instead of feeling like a reset.",
      "Character identity remains stable across costume, hair, makeup, body shape, and hero props.",
      "Story action is legible without guesswork, and viewers can tell what happened and why it connects to the next beat.",
      "Camera motion, composition, clarity, and lighting stay stable without sudden blur, collapse, or spatial discontinuity.",
      "The ending leaves a clean handoff so the next segment can continue from the final gesture, eyeline, or frame center.",
    ],
  },
  {
    title: "Negative anchors",
    items: [
      "The character suddenly changes face, costume, hairstyle, or identity inside the same clip.",
      "The action chain breaks, with the previous segment moving in one direction and this one freezing or teleporting elsewhere.",
      "The shot rhythm feels randomly stitched, so the viewer cannot read story progression or emotional cause and effect.",
      "Visible subtitles, watermarks, screen text, severe face-hand collapse, axis jumps, or reset-like framing break deliverability.",
      "The clip ends without a usable handoff for the next segment.",
    ],
  },
  {
    title: "Quality tiers",
    items: [
      "golden: ready to cut directly into the episode, with stable continuity and clear narrative propulsion.",
      "usable: mostly production-ready, with only minor caveats that do not break continuity or readability.",
      "borderline: barely holds together, with visible issues that need local repair before delivery.",
      "fail: continuity, identity, semantics, or visual quality are broken enough that the clip should not ship as-is.",
    ],
  },
  {
    title: "High-quality exemplar",
    items: [
      "A TV-drama-ready segment: the last frame of the prior shot and the opening of this shot do not fight each other, character and spatial anchors stay stable, and the ending can hand off naturally into the next shot.",
    ],
  },
];

function renderSections(sections: GoldenSampleSection[]): string {
  return sections
    .map((section) =>
      [`${section.title}:`, ...section.items.map((item, index) => `${index + 1}. ${item}`)].join("\n"),
    )
    .join("\n\n");
}

export function buildReferenceImageGoldenSamplePromptContext(mode: "character" | "scene"): string {
  const sections = mode === "character" ? REFERENCE_CHARACTER_SECTIONS : REFERENCE_SCENE_SECTIONS;
  return [
    `Golden sample library version: ${VIDEO_QA_GOLDEN_SAMPLE_VERSION}.`,
    "Use this library as the positive standard for what a reusable high-quality production reference image looks like.",
    renderSections(sections),
    "Prefer concrete observations over vague praise. Reward images that look reusable for downstream continuity, not just attractive in isolation.",
  ].join("\n\n");
}

export function buildSegmentVideoGoldenSamplePromptContext(): string {
  return [
    `Golden sample library version: ${VIDEO_QA_GOLDEN_SAMPLE_VERSION}.`,
    "Use this library as the positive standard for what a high-quality stitch-ready dramatic segment looks like.",
    renderSections(SEGMENT_VIDEO_SECTIONS),
    "A strong answer should name both the matched golden signals and the first repair priorities when the clip falls short.",
  ].join("\n\n");
}
