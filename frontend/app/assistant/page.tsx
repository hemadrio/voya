/**
 * Assistant chat page — entry point for the AI travel assistant (WO-062).
 *
 * Requires authentication (the gateway enforces JWT; this page is not in the
 * guest allow-list). The ChatPanel manages all streaming state client-side.
 */

import type React from "react";
import type { Metadata } from "next";
import { ChatPanel } from "@/components/assistant/ChatPanel.js";

export const metadata: Metadata = {
  title: "Travel Assistant",
  description: "Get personalised travel recommendations and book flights, hotels, and cars.",
};

// Chat data must never be cached — streaming state is always live
export const dynamic = "force-dynamic";

interface AssistantPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default function AssistantPage({ searchParams }: AssistantPageProps): React.ReactElement {
  const conversationId =
    typeof searchParams?.["conversationId"] === "string"
      ? searchParams["conversationId"]
      : undefined;

  return (
    <main
      className="flex h-[calc(100dvh-4rem)] flex-col"
      aria-label="Assistant chat"
    >
      <ChatPanel conversationId={conversationId} className="h-full" />
    </main>
  );
}
