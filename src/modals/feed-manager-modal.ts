import { AddFeedModal } from "./feed-manager/add-feed-modal";
import { EditFeedModal } from "./feed-manager/edit-feed-modal";
import { FeedManagerModal } from "./feed-manager/feed-manager-modal";
import { AddSourceModal } from "./source-onboarding/add-source-modal";

// Ensure this thin re-export wrapper registers executable statements in V8
// coverage (otherwise it can show as 0% even when imported).
const __reexports = { AddFeedModal, AddSourceModal, EditFeedModal, FeedManagerModal };
void __reexports;

export { AddFeedModal, AddSourceModal, EditFeedModal, FeedManagerModal };
