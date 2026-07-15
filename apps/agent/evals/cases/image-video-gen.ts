/**
 * image-video-gen.ts — Eval cases for xAI image and video generation tools.
 *
 * NOTE: In the eval mock, generate_image/generate_video return a success message
 * but don't push to pendingMedia. In production, the agent loop has an extra round
 * where the model sees the generated media as a FilePart. This means the mock can't
 * fully test the "review then send" flow. These evals focus on:
 * - Correct tool selection and parameters
 * - Always sending after generating (via send_message with media_path)
 * - Not generating unprompted
 * - Empty/absent (not invented) source params for text-to-video
 * - Brief preambles before async generation
 */
import type { EvalCase } from "../types.js";

export const cases: EvalCase[] = [
  // ── Image Generation ──

  {
    id: "image-gen-basic",
    description:
      "User asks to generate an image — agent should call generate_image and send_message with media_path",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_001]\ngenerate an image of a golden retriever playing in the snow and send it to me",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        { name: "generate_image" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/img_mock_0.jpg" } },
      ],
    },
    judgeCriteria: [
      "The agent generated the image and sent it via send_message with media_path. It should not just describe the image in text without sending.",
    ],
  },

  {
    id: "image-gen-sends-not-describes",
    description:
      "User asks to make a picture and send it — agent must generate AND send, not just describe",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_002]\nmake me a picture of a sunset and send it here",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        { name: "generate_image" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/img_mock_0.jpg" } },
      ],
      responseNotContains: ["i would generate", "imagine a sunset"],
    },
    judgeCriteria: [
      "The agent called send_message with media_path to deliver the image. It did NOT just describe it in text. Score 1 if only described, 5 if generated and sent.",
    ],
  },

  {
    id: "image-gen-with-edit",
    description:
      "User asks to edit an image — agent should call generate_image with source_image_url set",
    history: [
      {
        role: "assistant",
        text: "Image generated and saved to: /tmp/xchat-agent/img_prev.jpg",
      },
    ],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_003]\nedit that image to add a rainbow in the background and send it",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        {
          name: "generate_image",
          args: { source_image_url: "/tmp/xchat-agent/img_prev.jpg" },
        },
        { name: "send_message" },
      ],
    },
    judgeCriteria: [
      "The agent correctly identified the previously generated image path and passed it as source_image_url to generate_image for editing.",
    ],
  },

  {
    id: "image-gen-multiple",
    description:
      "User asks for multiple image variations — agent should call generate_image with n=3, not 3 separate calls",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_004]\ngenerate 3 variations of a minimalist logo with a mountain silhouette",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [{ name: "generate_image", args: { n: 3 } }],
    },
    judgeCriteria: [
      "The agent used one generate_image call with n=3 to batch-generate variations. It should NOT make 3 separate calls — the n parameter exists for this purpose.",
    ],
  },

  // ── Video Generation ──

  {
    id: "video-gen-basic",
    description:
      "User asks for a video — agent should call generate_video and send_message with media_path",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_006]\ngenerate a video of ocean waves crashing on a beach and send it to me",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        { name: "generate_video" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/video_mock.mp4" } },
      ],
    },
    judgeCriteria: [
      "The agent generated the video and sent it via send_message with media_path.",
    ],
  },

  {
    id: "video-gen-from-image",
    description:
      "User asks to turn a previously generated image into a video — agent should pass that image path as source_image_url and send the result",
    history: [
      {
        role: "user",
        text: "[conversation: conv-test-123, message: MSG_007a]\ngenerate an image of a rocket launch",
      },
      {
        role: "assistant",
        text: "Image generated and saved to: /tmp/xchat-agent/img_rocket.jpg",
      },
    ],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_007b]\nturn that image into a video and send it",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        {
          name: "generate_video",
          args: { source_image_url: "/tmp/xchat-agent/img_rocket.jpg" },
        },
        { name: "send_message" },
      ],
    },
    judgeCriteria: [
      "The agent used source_image_url with the previous image path for image-to-video generation (the unused source_video_url may be left empty/absent), then sent the result via send_message.",
    ],
  },

  {
    id: "video-gen-sends-not-describes",
    description:
      "Agent must actually send the generated video, not just describe the preview frame",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_008]\nmake me a video of fireworks and send it here",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        { name: "generate_video" },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/video_mock.mp4" } },
      ],
      responseNotContains: ["the preview shows", "i can see in the frame"],
    },
    judgeCriteria: [
      "The agent sent the video via send_message with media_path, not just described it. Score 1 if only described, 5 if sent.",
    ],
  },

  {
    id: "video-gen-text-to-video-no-source",
    description:
      "Text-to-video: agent must not invent a source_image_url/source_video_url (they should be empty/absent — the handler treats empty string, [] and null all as unused), then send the result",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_009]\ncreate a video of a cat jumping over a fence and send it",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [{ name: "generate_video" }, { name: "send_message" }],
    },
    judgeCriteria: [
      "For text-to-video the agent must NOT pass a real source_image_url or source_video_url — those should be left empty/absent (the handler treats empty string, [] and null all as 'unused', so an empty value is correct). The agent generated the video and sent it via send_message. Score 5 if no bogus source was invented and it sent; score 1 if it fabricated a source path.",
    ],
  },

  // ── Combined Workflows ──

  {
    id: "image-then-video-pipeline",
    description:
      "User asks to generate an image, animate that specific image into a video, and send both",
    history: [
      {
        role: "user",
        text: "[conversation: conv-test-123, message: MSG_010a]\ngenerate an image of a futuristic cityscape and send it",
      },
      {
        role: "assistant",
        text: "Image generated and saved to: /tmp/xchat-agent/img_city.jpg",
      },
    ],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_010b]\nnow turn that image at /tmp/xchat-agent/img_city.jpg into a 5 second video and send it to me",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [
        {
          name: "generate_video",
          args: { source_image_url: "/tmp/xchat-agent/img_city.jpg" },
        },
        { name: "send_message", args: { media_path: "/tmp/xchat-agent/video_mock.mp4" } },
      ],
    },
    judgeCriteria: [
      "The agent used the image path from history as source_image_url in generate_video to create an image-to-video, then sent the result. Score 1 if missing send, 3 if text-to-video instead of image-to-video, 5 if correct image-to-video with send.",
    ],
  },

  {
    id: "no-image-gen-unprompted",
    description:
      "User makes a casual comment about a sunset — agent should NOT call generate_image",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_011]\nthe sunset was beautiful today",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      noToolCalls: true,
      minMessages: 1,
    },
    judgeCriteria: [
      "The agent responded conversationally without calling generate_image or generate_video. It should NOT generate media unless explicitly asked.",
    ],
  },

  // ── Preamble / UX ──

  {
    id: "image-gen-preamble",
    description:
      "When generating an image, agent should generate and send it — text in the send_message is the preamble",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_012]\ngenerate an image of a dragon flying over mountains and send it",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [{ name: "generate_image" }, { name: "send_message" }],
    },
    judgeCriteria: [
      "The agent generated the image and sent it. The send_message text (or a preceding text message) should be brief and natural (e.g. 'here's your dragon'). Score 1 if no send, 3 if overly verbose text, 5 if brief and sent.",
    ],
  },

  {
    id: "video-gen-preamble",
    description: "When generating a video, agent should generate and send it",
    history: [],
    incomingMessage:
      "[conversation: conv-test-123, message: MSG_013]\nmake me a video of a waterfall in slow motion and send it",
    sender: { id: "user-1", screenName: "Zach" },
    conversationConfig: { toolkits: ["xchat", "xai"] },
    expect: {
      toolCalls: [{ name: "generate_video" }, { name: "send_message" }],
    },
    judgeCriteria: [
      "The agent generated the video and sent it. The send_message text should be brief. Score 1 if no send, 3 if overly verbose, 5 if brief and sent.",
    ],
  },

  // ── Production regression: describe-then-send loop ──

  {
    id: "image-gen-send-not-describe-after-correction",
    description:
      "After generating an image and describing it as text, user says 'send the actual image' — model should send once and stop",
    history: [
      {
        role: "user",
        text: "Zach [msg:1001]: Can you send me a realistic image of a shark eating a cheeseburger",
      },
      {
        role: "assistant",
        text: "A massive great white shark underwater, mouth wide open mid-bite on a big juicy cheeseburger. Melted cheese dripping, sesame bun, lettuce visible. Super realistic.",
      },
    ],
    incomingMessage:
      "[conversation: conv-dm, message: 1003]\nZach [msg:1003]: Send the actual image",
    sender: { id: "admin-user-1", screenName: "Zach" },
    globalAdmins: ["admin-user-1"],
    conversationConfig: {
      toolkits: { admin: ["xchat", "xai"], user: ["xchat"] },
    },
    expect: {
      toolCalls: [{ name: "send_message" }],
      maxMessages: 1,
    },
    judgeCriteria: [
      "The agent calls send_message exactly once with media_path to send the previously generated image. It should NOT call send_message multiple times. Score 5 if one send_message call, 3 if 2-3 calls, 1 if more than 3 calls.",
    ],
  },
];
