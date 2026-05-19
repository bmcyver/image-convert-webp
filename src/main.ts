import { type Editor, Notice, Plugin, TFile } from "obsidian";

const QUALITY = 85;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

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

async function handleFileMenuClickEvent(plugin: Plugin, targetFile: TFile) {
	if (/.+-\d+\.webp$/i.test(targetFile.name)) {
		return new Notice("This file seems to be already converted.");
	}
	
	const data = await plugin.app.vault.readBinary(targetFile);
	const file = new File([data], targetFile.name, { type: targetFile.extension === "jpg" ? "image/jpeg" : `image/${targetFile.extension}` });
	
	const webpData = await toWebP(file);
	await plugin.app.vault.modifyBinary(targetFile, webpData);
	await plugin.app.fileManager.renameFile(targetFile, `/assets/${new Date().getFullYear()}/${normalizeFileName(targetFile.basename)}-${Date.now()}.webp`);

	const originalSizeKB = (file.size / 1024).toFixed(2);
	const createdSizeKB = (webpData.byteLength / 1024).toFixed(2);

	new Notice(`${targetFile.basename}\n(${originalSizeKB} KB -> ${createdSizeKB} KB ${Math.round(((file.size - webpData.byteLength) / file.size) * 100)}%)`);
}

async function handleDropPasteEvent(plugin: Plugin, file: File, editor: Editor) {
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile) {
		return new Notice("No active file to attach the image to.");
	}

	const destinationPath = `/assets/${new Date().getFullYear()}/${normalizeFileName(activeFile.basename)}-${Date.now()}.webp`;
	const data = await toWebP(file);
	const createdFile = await plugin.app.vault.createBinary(destinationPath, data);
	editor.replaceSelection(`![[${createdFile.path}]]`);

	const origianlSizeKB = (file.size / 1024).toFixed(2);
	const createdSizeKB = (createdFile.stat.size / 1024).toFixed(2);
	return new Notice(`${createdFile.basename}\n(${origianlSizeKB} KB -> ${createdSizeKB} KB ${Math.round(((file.size - createdFile.stat.size) / file.size) * 100)}%)`);
}



export default class WebPPastePlugin extends Plugin {
	async onload() {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, targetFile) => {
				if (!(targetFile instanceof TFile) || !SUPPORTED_IMAGE_EXTENSIONS.includes(targetFile.extension.toLowerCase())) {
					return;
				}
				menu.addItem((item) => {
					item.setTitle("Convert to WebP")
						.setIcon("image-down")
						.onClick(async () => {
							return handleFileMenuClickEvent(this, targetFile);
						});
				});

			}),
		);

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
				return handleDropPasteEvent(this, file, editor);
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
				return handleDropPasteEvent(this, file, editor);
			}),
		)
	}
}