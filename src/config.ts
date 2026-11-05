export interface Post {
  handle: string; // "@name"
  displayName: string;
  text: string;
}

export interface Source {
  id: string;
  name: string;
  /** The YouTube channel picture, 96px square. */
  avatar: string;
  /** OKLCH hue of the page accent: Theo's pink, Prime's orange. */
  hue: number;
  /** The creator's own X handle, without the @. */
  xHandle: string;
  /** One creator can post on several channels. */
  youtubeChannelIds: string[];
  detectors: string[];
}

export interface Detector {
  id: string;
  label: string;
  frameState: string;
  frameQuestion: string;
  frameThreshold: number;
  readerPrompt: string;
  readAloudQuestion(post: Post): string;
  readAloudThreshold: number;
  quoteInstructions(post: Post): string;
}

export const SOURCES: Source[] = [
  {
    id: "theo",
    name: "Theo",
    hue: 350,
    xHandle: "theo",
    avatar: "https://yt3.googleusercontent.com/Y6jut5A-dhWRlv7W81kGxVFPtZGjZN97IhBP75uLnx2AVV7ZEJUUUxBKHlFw9GcwILxkz1E_cLc=s96-c-k-c0x00ffffff-no-rj",
    youtubeChannelIds: ["UCbRP3c757lWg9M-U7TyEkXA"],
    detectors: ["x-post"],
  },
  // The PrimeTime, then ThePrimeagen.
  {
    id: "prime",
    name: "Prime",
    hue: 55,
    xHandle: "ThePrimeagen",
    avatar: "https://yt3.googleusercontent.com/Eu_xR4JfLlrruwj1lrmfDiOpe8GARBs8M0hgQ6NsGhQ0qC8S-po9HEHw1W21sPN2BHO6EHXrSwM=s96-c-k-c0x00ffffff-no-rj",
    youtubeChannelIds: ["UCUyeluBRhGPCW4rPe_UvBZQ", "UC8ENHE5xdFSwx71u3fDH5Xw"],
    detectors: ["x-post"],
  },
];

const postRef = (post: Post) => `this X post by ${post.handle}: "${post.text}"`;

export const DETECTORS: Detector[] = [
  {
    id: "x-post",
    label: "X post",
    frameState: "A frame from a YouTube video by a tech streamer: a screen recording of a web browser with a facecam overlay.",
    frameQuestion:
      "Is a post from X (Twitter) clearly visible and readable as main content of the screen (a post page, timeline, search results, embed or screenshot)? An X post shows an avatar, a display name, an @handle and the post text. Small sidebar items and avatars do not count. A live chat, a stream dashboard, an activity feed, or a YouTube page with no X post in its video does not count.",
    frameThreshold: 0.5,
    readerPrompt:
      "This is a frame from a screen recording. Transcribe every X (Twitter) post visible on screen, including replies and quoted posts. Live stream chat is not X. " +
      "Output one line per post: @handle | display name | post text. Copy characters exactly; write ? for anything unreadable. Output nothing else.",
    readAloudQuestion: (post) =>
      `This is a transcript of a tech streamer while ${postRef(post)} is on screen. Does the speaker read aloud, quote or paraphrase that post's content?`,
    readAloudThreshold: 0.3,
    quoteInstructions: (post) =>
      `The words where the speaker reads aloud, quotes or paraphrases ${postRef(post)}. Null if the speaker does not.`,
  },
];

export const MAX_IN_FLIGHT = 3;
export const MAX_RETRIES = 3;
export const RETRY_BASE_MINUTES = 30;
export const MIN_DURATION_SECONDS = 120;
export const DEFAULT_SOURCE = "theo";

export function getSource(id: string | null | undefined): Source | undefined {
  return SOURCES.find((s) => s.id === (id || DEFAULT_SOURCE));
}

export function getDetector(id: string): Detector {
  const detector = DETECTORS.find((d) => d.id === id);
  if (!detector) throw new Error(`unknown detector ${id}`);
  return detector;
}
