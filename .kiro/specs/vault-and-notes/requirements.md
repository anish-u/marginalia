# Requirements Document

## Introduction

This feature introduces persistence to Marginalia by way of a **vault** — a plain folder on the user's device that holds their resource notes. Today, note and highlight state is in-memory per window and is lost when a window closes. This feature lets the user create or open a vault through the operating system's file browser, view a list of the resource notes it contains in the main window, and have each resource note stored on disk in a human-readable, app-independent format.

A **resource note** pairs a *resource* (an external thing the note is about) with *note content* (the user's writing plus clipped highlights). The resource is a tagged type so that additional resource kinds can be added later. Only the **website link** resource type is in scope for this feature; **PDF** and **Video** are explicitly out of scope and reserved as future work, but the stored data model and the in-memory contracts SHALL be structured so those types can be added without reworking existing storage or the resource-note schema.

A guiding constraint is **local accessibility**: notes must remain readable and meaningful on disk without the Marginalia app, and the vault folder is the single source of truth for notes (no separate database is required by these requirements). The exact on-disk file format (for example, a Markdown file with frontmatter, or a JSON sidecar) is a design decision deferred to the design phase; this document captures the properties that format must satisfy rather than prescribing it.

Because all main-process/filesystem access in Marginalia flows through the single typed preload bridge (IPC), every filesystem operation described here is performed by the main process on behalf of the renderer.

## Glossary

- **Vault**: A user-selected folder on the local filesystem that serves as the single source of truth for a set of resource notes. The vault is the durable store; there is no separate database.
- **Vault_Manager**: The main-process component responsible for creating a vault, opening (selecting) an existing vault, and tracking which vault is currently active.
- **Active_Vault**: The vault currently opened in the application. At most one vault is active at a time.
- **Resource_Note**: A persisted entity pairing a Resource with Note_Content, plus metadata (identifier, title, timestamps).
- **Resource**: The external subject a Resource_Note is about, modeled as a tagged (discriminated) type with a `type` discriminator. The only implemented variant is Website_Link; PDF and Video are reserved future variants.
- **Website_Link**: A Resource variant identified by a web URL. The only Resource type implemented in this feature.
- **Note_Content**: The user-authored body of a Resource_Note, consisting of rich-text prose and embedded clipped highlights.
- **Highlight**: A clipped text-quote anchor captured from the resource's web page, as defined by the existing `@shared/highlight` `Highlight` type (text, prefix, suffix, url, id, createdAt).
- **Note_Store**: The main-process component that reads Resource_Notes from and writes Resource_Notes to the Active_Vault on disk.
- **Notes_List_View**: The view in the main window that lists the Resource_Notes contained in the Active_Vault.
- **File_Browser**: The operating system's native folder-selection dialog, presented via Electron's `dialog` API.
- **Note_File**: The on-disk representation of a single Resource_Note within the vault, in a human-readable, app-independent format.
- **Vault_Marker**: A persistent, recognizable artifact created within a folder when it is designated as a vault, allowing the folder to be recognized as a vault on a later open.
- **Creation_Timestamp**: The moment a Resource_Note is first persisted, expressed as epoch milliseconds. Set once on the first write and not changed thereafter.
- **Last_Modified_Timestamp**: The moment a Resource_Note was most recently modified or written, expressed as epoch milliseconds.

## Requirements

### Requirement 1: Create a vault

**User Story:** As a note-taker, I want to create a new vault in a folder I choose, so that I have a dedicated local place for my resource notes.

#### Acceptance Criteria

1. WHEN the user initiates vault creation, THE Vault_Manager SHALL present the File_Browser for the user to choose a folder location.
2. WHEN the user confirms a folder in the File_Browser during vault creation, THE Vault_Manager SHALL designate the chosen folder as a vault by creating a persistent vault marker within it, and SHALL set the folder as the Active_Vault.
3. WHEN the Vault_Manager designates a folder as a vault, THE Vault_Manager SHALL create a persistent, recognizable vault marker that allows the folder to be recognized as a vault on a later open.
4. IF the user selects a folder that already contains a vault marker during vault creation, THEN THE Vault_Manager SHALL set that existing folder as the Active_Vault without overwriting its existing contents.
5. WHEN a folder is successfully designated as the Active_Vault, THE Vault_Manager SHALL provide a success indication to the renderer.
6. IF the user cancels or dismisses the File_Browser during vault creation, THEN THE Vault_Manager SHALL leave the Active_Vault unchanged and SHALL NOT return an error.
7. IF the chosen folder cannot be written to or the vault marker cannot be created, THEN THE Vault_Manager SHALL return an error identifying the failure and SHALL leave the Active_Vault unchanged.

### Requirement 2: Open an existing vault

**User Story:** As a note-taker, I want to open a vault folder I created earlier, so that I can access the resource notes stored in it.

#### Acceptance Criteria

1. WHEN the user initiates opening a vault, THE Vault_Manager SHALL present the File_Browser configured to allow selection of exactly one existing folder.
2. WHEN the user selects a folder that contains the vault marker created at vault creation time, THE Vault_Manager SHALL set that folder as the Active_Vault, replacing any previously Active_Vault so that at most one vault is active at a time.
3. IF the user selects a folder that does not contain the vault marker, THEN THE Vault_Manager SHALL return an error indicating the selected folder is not a vault and SHALL leave the Active_Vault unchanged.
4. IF the user selects a folder whose vault marker exists but cannot be read (for example, the marker is inaccessible or its contents are unreadable or malformed), THEN THE Vault_Manager SHALL return an error indicating the vault could not be opened and SHALL leave the Active_Vault unchanged.
5. IF the user cancels or dismisses the File_Browser without selecting a folder, THEN THE Vault_Manager SHALL leave the Active_Vault unchanged and SHALL NOT return an error.
6. WHEN a folder becomes the Active_Vault, THE Vault_Manager SHALL make the absolute filesystem path of that folder available to the renderer through the preload IPC bridge for display.

### Requirement 3: List resource notes in the main window

**User Story:** As a note-taker, I want the main window to show the resource notes in my open vault, so that I can see and choose which note to work on.

#### Acceptance Criteria

1. WHILE a vault is the Active_Vault, THE Notes_List_View SHALL display one entry for each Resource_Note stored in the Active_Vault, ordered by most-recently-modified first.
2. WHILE no vault is the Active_Vault, THE Notes_List_View SHALL present actions to create a vault and to open a vault.
3. WHEN the Active_Vault changes, THE Notes_List_View SHALL, within 1 second, replace the displayed entries with the Resource_Notes of the newly Active_Vault and clear any prior entry selection.
4. THE Notes_List_View SHALL display, for each entry, the Resource_Note title and a resource-type indicator identifying the entry as a website-link note.
5. IF a Resource_Note title is empty or contains only whitespace, THEN THE Notes_List_View SHALL display a placeholder label in place of the title.
6. WHEN the user selects an entry in the Notes_List_View, THE System SHALL open that Resource_Note in a resource-note window.
7. IF the Active_Vault contains no Resource_Notes, THEN THE Notes_List_View SHALL display an empty-state message.
8. IF opening the selected Resource_Note fails, THEN THE System SHALL leave the Notes_List_View displayed with its current entries unchanged and present an error message indicating that the note could not be opened.

### Requirement 4: Represent resource notes with an extensible resource type

**User Story:** As a developer, I want the resource note structure to model the resource as a tagged type, so that PDF and Video resources can be added later without reworking existing notes or storage.

#### Acceptance Criteria

1. THE Resource_Note SHALL contain exactly one Resource, exactly one Note_Content, a stable identifier that is unique among all Resource_Notes and immutable for the lifetime of the Resource_Note, a title of 0 to 255 characters, a creation timestamp expressed as epoch milliseconds, and a last-modified timestamp expressed as epoch milliseconds.
2. THE Resource SHALL include a `type` discriminator field whose value is exactly one of the recognized variant identifiers: Website_Link, PDF, or Video.
3. WHERE the Resource `type` is Website_Link, THE Resource SHALL include the web URL of the linked page as a non-empty string using the http or https scheme.
4. WHERE the Resource `type` is PDF or Video, THE Resource_Note SHALL treat the variant as reserved and SHALL NOT provide variant-specific creation, reading, or rendering behavior in the current implementation.
5. IF a Note_File is read whose Resource `type` is not one of the recognized variant identifiers, THEN THE Note_Store SHALL return an error that identifies the unrecognized `type` value, SHALL NOT discard or modify the Note_File, and SHALL leave the stored Note_File unchanged.
6. THE Resource_Note SHALL represent Note_Content in a form that preserves the rich-text prose and every embedded Highlight, retaining for each Highlight its id, text, prefix, suffix, url, and createdAt fields as defined by the existing `Highlight` type.
7. WHEN any field of a Resource_Note is modified, THE Resource_Note SHALL update its last-modified timestamp to the time of the modification expressed as epoch milliseconds.

### Requirement 5: Persist a resource note to the vault

**User Story:** As a note-taker, I want my resource note saved into the vault folder, so that my writing and clips are durable and survive closing the window.

#### Acceptance Criteria

1. WHEN the user saves a Resource_Note, THE Note_Store SHALL write the Resource_Note as a single Note_File within the Active_Vault folder and SHALL complete the write within 2 seconds for a Note_Content of up to 1,000,000 characters.
2. WHEN the Note_Store writes a Note_File, THE Note_Store SHALL record the Resource_Note's unique identifier, title, Resource, Note_Content, a created timestamp, and a last-modified timestamp.
3. WHEN a Resource_Note whose unique identifier already matches an existing Note_File in the Active_Vault is saved, THE Note_Store SHALL overwrite that existing Note_File in place and SHALL NOT create an additional Note_File.
4. WHEN the Note_Store writes a Note_File, THE Note_Store SHALL set the Resource_Note's last-modified timestamp to the system clock time at the moment the write begins, and on the first write SHALL set the created timestamp to the same value.
5. IF writing a Note_File fails, THEN THE Note_Store SHALL return an error result indicating the write failed and identifying the affected Resource_Note by its unique identifier, and SHALL leave any previously written Note_File for that Resource_Note byte-for-byte unchanged.
6. IF no vault is set as the Active_Vault when a save is requested, THEN THE Note_Store SHALL reject the save, return an error result indicating that no vault is open, and SHALL NOT create any Note_File.
7. IF the Resource_Note's title is empty when a save is requested, THEN THE Note_Store SHALL write the Note_File using a default non-empty title and SHALL record that default title in the Note_File.

### Requirement 6: Load resource notes from the vault

**User Story:** As a note-taker, I want to reopen a saved resource note, so that I can continue reading, writing, and reviewing my clips.

#### Acceptance Criteria

1. WHEN the Active_Vault is set, THE Note_Store SHALL enumerate every readable Note_File it contains and provide the corresponding Resource_Note list to the renderer ordered by most-recent modification timestamp first.
2. WHILE the Active_Vault contains no readable Note_Files, THE Note_Store SHALL provide an empty Resource_Note list to the renderer without returning an error.
3. WHEN a Resource_Note is opened, THE Note_Store SHALL provide its Resource, Note_Content, title, identifier, creation timestamp, and last-modified timestamp to the renderer.
4. IF an open is requested for a Resource_Note identifier that no longer exists in the Active_Vault, THEN THE Note_Store SHALL return an error indicating the identifier was not found and SHALL leave the Active_Vault and its remaining Note_Files unchanged.
5. WHEN a Resource_Note loaded from a Note_File is opened in a resource-note window, THE System SHALL restore the note's prose and Highlights so that clicking a Highlight whose text-quote anchor is found scrolls the resource page to that Highlight.
6. IF a Highlight's text-quote anchor cannot be located on the current resource page, THEN THE System SHALL still restore the note's prose, SHALL retain the Highlight in the note, and SHALL indicate to the user that the Highlight could not be located on the page.
7. IF a Note_File cannot be read or parsed, THEN THE Note_Store SHALL return an error identifying the affected Note_File, SHALL exclude only that Note_File from the Resource_Note list, and SHALL continue providing the remaining readable Resource_Notes.

### Requirement 7: Store notes in a human-readable, app-independent format

**User Story:** As a note-taker, I want my notes stored in an open, readable format inside the vault folder, so that I can access their content without the Marginalia app.

#### Acceptance Criteria

1. WHEN the Note_Store persists a Resource_Note, THE Note_Store SHALL write it as a Note_File encoded in a UTF-8, text-based format whose full content is displayable as readable characters in a standard text editor without binary decoding.
2. THE Note_Store SHALL store every Resource_Note as a Note_File located within the Active_Vault folder, and THE Note_Store SHALL treat the Active_Vault folder as the single source of truth, reading and writing Resource_Notes only from that folder with no separate database.
3. THE Note_File SHALL record the Resource_Note's prose content as readable text, its title, its associated Resource, and its Highlights.
4. WHEN a Resource_Note is written to a Note_File and that Note_File is subsequently read back, THE Note_Store SHALL produce a Resource_Note equivalent to the original, where equivalence means the title string, the Resource, the prose text content, and the ordered set of Highlights (each preserving its quoted text and anchor context) are all identical to the original.
5. WHERE the Active_Vault folder has been moved or copied to a different filesystem location or device, WHEN that folder is opened as the Active_Vault, THE Note_Store SHALL read and list all Resource_Notes contained in the relocated folder without requiring any data external to that folder.
6. IF a file within the Active_Vault folder cannot be parsed as a valid Note_File when read, THEN THE Note_Store SHALL exclude that file from the loaded Resource_Notes, leave the file unmodified on disk, and surface an indication identifying the unreadable file.
