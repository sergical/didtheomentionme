import { UNKNOWN_HANDLE } from "./pipeline";

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
  pageThreshold: number;
  chatQuestion: string;
  chatThreshold: number;
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

const postName = (post: Post) => `this X post${post.handle === UNKNOWN_HANDLE ? "" : ` by ${post.handle}`}`;
const postRef = (post: Post) => `${postName(post)}: "${post.text}"`;

export const DETECTORS: Detector[] = [
  {
    id: "x-post",
    label: "X post",
    frameState: "A frame from a YouTube video by a tech streamer: a screen recording of a web browser with a facecam overlay.",
    frameQuestion:
      "Is a post from X (Twitter) clearly visible and readable as main content of the screen (a post page, timeline, search results, embed or screenshot)? An X post shows an avatar, a display name, an @handle and the post text. Small sidebar items and avatars do not count. A live chat, a stream dashboard, an activity feed, or a YouTube page with no X post in its video does not count. An Instagram page does not count.",
    /** Real posts scored 0.82 or more on 61 sampled frames and in all 15 labelled intervals. Stream chat scored up to 0.61. Instagram pages scored up to 0.90 before their sentence and 0.40 or less after it. */
    frameThreshold: 0.75,
    /** The same question on the 1920 px frame. Of 33 hand-checked frames, real posts scored 0.76 or more, stream chat and a YouTube page 0.15, and a blog and chat on X 0.74. Another blog page scored 0.85. */
    pageThreshold: 0.65,
    chatQuestion: "Is the main content of this frame a live stream chat panel (Twitch or YouTube chat) with many short messages from viewers?",
    /** On 41 frames with 8 or more reader lines, a wall of real posts scored 0.06, a post page beside a chat 0.17, and the other 39 scored 0.80 or more. Other real frames scored 0.35 or less, and chat on X 0.49. */
    chatThreshold: 0.45,
    readerPrompt:
      "This is a frame from a screen recording. Transcribe every X (Twitter) post on screen, including replies and quoted posts. Posts shown as a screenshot or on a wall of posts count.\n" +
      "Do not transcribe live stream chat (even chat on X), the Live on X panel, live stream titles, Relevant people, Who to follow, Trends or profile bios. If the screen shows another website or app, such as Instagram, a blog, docs, email, Discord or Twitch, and no X post, output NONE.\n" +
      "Output one line per post: @handle | display name | post text. Copy characters exactly; write ? for anything unreadable. When a post's content is an image or screenshot of text, the post text is the text in that image. If the post's @handle is not visible on screen, write @unknown; never guess a handle from a name. If there are no X posts, output NONE. Output nothing else.",
    readAloudQuestion: (post) =>
      `This is a transcript of a tech streamer while ${postRef(post)} is on screen. Does the speaker read aloud, quote or paraphrase that post's content?`,
    readAloudThreshold: 0.3,
    /**
     * Asked only for "the words", Clairic answers with a lone name such as "enterprise", often far from the reading.
     * Keep the post text after "word for word": with it before, 5 of 39 real readings came back as "Yes" or a name.
     */
    quoteInstructions: (post) =>
      `The complete sentence or sentences where the speaker starts reading ${postName(post)} word for word: "${post.text}". Copy at least ten words. Do not return a single name. Null if the speaker does not read it.`,
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
