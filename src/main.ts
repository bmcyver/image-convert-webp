import { type Editor, Notice, Plugin } from "obsidian";

const QUALITY = 85;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function toWebP(file: File): Promise<ArrayBuffer> {
	const bitmap = await createImageBitmap(file);

	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext("2d");

		if (!ctx) {
			throw new Error("Failed to create canvas context.");
		}

		ctx.drawImage(bitmap, 0, 0);

		const blob = await canvas.convertToBlob({
			type: "image/webp",
			quality: Math.max(0, Math.min(1, QUALITY / 100))
		});

		return await blob.arrayBuffer();
	} finally {
		bitmap.close();
	}
}

function normalizeFileName(name: string): string {
	//eslint-disable-next-line no-useless-escape
	return name.normalize('NFC').replace(/[\\\/:*?"<>|[\]#^]/g, '')
		.replace(/\s+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

async function handleImage(plugin: Plugin, file: File, editor: Editor) {
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile) {
		return new Notice("No active file to attach the image to.");
	}

	const origianlSizeKB = (file.size / 1024).toFixed(2);

	const destinationPath = `/assets/${new Date().getFullYear()}/${normalizeFileName(activeFile.basename)}-${Date.now()}.webp`;
	const data = await toWebP(file);
	const createdFile = await plugin.app.vault.createBinary(destinationPath, data);
	editor.replaceSelection(`![[${createdFile.path}]]`);

	return new Notice(`Image converted to WebP and saved as ${createdFile.basename} (${origianlSizeKB} KB -> ${(createdFile.stat.size / 1024).toFixed(2)} KB)`);
}

export default class WebPPastePlugin extends Plugin {
	async onload() {
		this.registerEvent(
			this.app.workspace.on("editor-paste", async (evt: ClipboardEvent, editor: Editor) => {
				if (!evt.clipboardData?.items || evt.defaultPrevented) return;

				let file: File | null = null;
				for (const item of evt.clipboardData.items) {
					if (item.kind === "file") {
						file = item.getAsFile()!;
						break;
					}
				}

				if (!file || !file.type.startsWith("image/")) {
					return;
				} else if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
					return new Notice('Only JPEG, PNG, and WebP are supported.');
				}

				evt.preventDefault();
				return handleImage(this, file, editor);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", async (evt: DragEvent, editor: Editor) => {
				if (!evt.dataTransfer?.files?.[0] || evt.defaultPrevented) return;

				const file = evt.dataTransfer.files[0];
				if (!file || !file.type.startsWith("image/")) {
					return;
				} else if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
					return new Notice('Only JPEG, PNG, and WebP are supported.');
				}

				evt.preventDefault();
				return handleImage(this, file, editor);
			}),
		)
	}
}