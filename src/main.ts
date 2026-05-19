import { type Editor, Notice, Plugin, TFile } from "obsidian";
import type HeicDecode from "heic-decode";

let heicDecode: typeof HeicDecode | null = null;

const QUALITY = 85;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"];
const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"];
const CONVERTED_NAME_REGEX = /.+-\d+\.(webp|avif)$/i;

const MIME_BY_EXTENSION: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	avif: "image/avif",
	heic: "image/heic",
	heif: "image/heif",
};

function getExtension(file: File | string): string {
	const name = typeof file === "string" ? file : file.name;
	return name.split(".").pop()?.toLowerCase() ?? "";
}

function isHeicFile(file: File | string): boolean {
	const ext = getExtension(file);
	if (ext === "heic" || ext === "heif") return true;
	return typeof file !== "string" && (file.type === "image/heic" || file.type === "image/heif");
}

function isAvifFile(file: File | string): boolean {
	const ext = getExtension(file);
	if (ext === "avif") return true;
	return typeof file !== "string" && file.type === "image/avif";
}

function isValidImageFile(file: File): boolean {
	if (isHeicFile(file)) return true;
	if (!file.type.startsWith("image/")) return false;
	if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
		new Notice("Only JPEG, PNG, WebP, AVIF, and HEIC are supported.");
		return false;
	}
	return true;
}

function getImageMimeType(extension: string): string {
	return MIME_BY_EXTENSION[extension.toLowerCase()] ?? `image/${extension}`;
}

function buildAssetPath(basename: string, extension: string): string {
	return `/assets/${new Date().getFullYear()}/${normalizeFileName(basename)}-${Date.now()}.${extension}`;
}

function normalizeFileName(name: string): string {
	return name.normalize('NFC')
		.replace(/[\\\/:*?"<>|[\]#^]/g, '')
		.replace(/\s+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

async function toWebP(file: File): Promise<ArrayBuffer> {
	let decoded: Awaited<ReturnType<typeof HeicDecode>> | null = null;

	if (isHeicFile(file)) {
		const heicData = new Uint8Array(await file.arrayBuffer());
		if (!heicDecode) {
			heicDecode = (await import("heic-decode")).default;
		}
		decoded = await heicDecode({ buffer: heicData });
	}

	const source = decoded
		? new ImageData(decoded.data as unknown as Uint8ClampedArray<ArrayBuffer>, decoded.width, decoded.height)
		: file;
	const bitmap = await createImageBitmap(source);

	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext("2d");

		if (!ctx) throw new Error("Failed to create canvas context.");
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

async function handleFileMenuEvent(plugin: Plugin, sourceFile: TFile): Promise<void> {
	if (CONVERTED_NAME_REGEX.test(sourceFile.name)) {
		new Notice("This file seems to be already converted.");
		return;
	}

	const sourceExtension = sourceFile.extension.toLowerCase();
	const shouldSkipConversion = isAvifFile(sourceExtension);

	const data = await plugin.app.vault.readBinary(sourceFile);
	const file = new File([data], sourceFile.name, { type: getImageMimeType(sourceExtension) });
	const destinationPath = buildAssetPath(sourceFile.basename, shouldSkipConversion ? "avif" : "webp");

	if (shouldSkipConversion) {
		await plugin.app.fileManager.renameFile(sourceFile, destinationPath);
		new Notice(`Skipped ${sourceFile.basename}\n(${(file.size / 1024).toFixed(2)} KB)`);
		return;
	}

	const outputData = await toWebP(file);
	await plugin.app.vault.modifyBinary(sourceFile, outputData);
	await plugin.app.fileManager.renameFile(sourceFile, destinationPath);

	const originalSizeKB = (file.size / 1024).toFixed(2);
	const createdSizeKB = (outputData.byteLength / 1024).toFixed(2);
	const ratio = Math.round(((file.size - outputData.byteLength) / file.size) * 100);

	new Notice(`Converted ${sourceFile.basename}\n(${originalSizeKB} KB -> ${createdSizeKB} KB ${ratio}%)`);
}

async function handleDropPasteEvent(plugin: Plugin, sourceFile: File, editor: Editor): Promise<void> {
	console.debug("[ImageConvertWebpPlugin]", "Handling drop/paste event for file:", sourceFile.name);
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile) {
		new Notice("No active file to attach the image to.");
		return;
	}

	const shouldSkipConversion = isAvifFile(sourceFile);
	const destinationPath = buildAssetPath(activeFile.basename, shouldSkipConversion ? "avif" : "webp");

	const outputData = shouldSkipConversion ? await sourceFile.arrayBuffer() : await toWebP(sourceFile);
	const createdFile = await plugin.app.vault.createBinary(destinationPath, outputData);
	editor.replaceSelection(`![[${createdFile.path}]]`);

	if (shouldSkipConversion) {
		new Notice(`Skipped ${createdFile.basename}\n(${(sourceFile.size / 1024).toFixed(2)} KB)`);
		return;
	}

	const originalSizeKB = (sourceFile.size / 1024).toFixed(2);
	const createdSizeKB = (createdFile.stat.size / 1024).toFixed(2);
	const ratio = Math.round(((sourceFile.size - createdFile.stat.size) / sourceFile.size) * 100);

	new Notice(`Converted ${createdFile.basename}\n(${originalSizeKB} KB -> ${createdSizeKB} KB ${ratio}%)`);
}

async function handleMarkdownMenuEvent(plugin: Plugin, noteFile: TFile): Promise<void> {
	const resolvedLinks = plugin.app.metadataCache.resolvedLinks[noteFile.path];
	if (!resolvedLinks) {
		new Notice("Failed to read file metadata.");
		return;
	}

	const linkedImageFiles = Object.keys(resolvedLinks)
		.map(link => plugin.app.vault.getFileByPath(link))
		.filter((file): file is TFile => file instanceof TFile && SUPPORTED_IMAGE_EXTENSIONS.includes(file.extension.toLowerCase()));

	if (linkedImageFiles.length === 0) {
		new Notice("No supported linked images found in this note.");
		return;
	}

	let successCount = 0;
	for (const imageFile of linkedImageFiles) {
		try {
			await handleFileMenuEvent(plugin, imageFile);
			successCount++;
		} catch (error) {
			new Notice(`Failed to convert ${imageFile.name}: ${(error as Error).message}`);
		}
	}

	new Notice(`Converted ${successCount} linked image(s) in this note.`);
}

export default class ImageConvertWebpPlugin extends Plugin {
	async onload() {
		console.debug("[ImageConvertWebpPlugin]", "Loading plugin");
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, targetFile) => {
				if (!(targetFile instanceof TFile)) return;

				const ext = targetFile.extension.toLowerCase();
				if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
					menu.addItem((item) => {
						item.setTitle("Convert image")
							.setIcon("image-down")
							.onClick(() => handleFileMenuEvent(this, targetFile));
					});
				} else if (ext === "md") {
					menu.addItem((item) => {
						item.setTitle("Convert all images")
							.setIcon("image-down")
							.onClick(() => handleMarkdownMenuEvent(this, targetFile));
					});
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-paste", async (evt: ClipboardEvent, editor: Editor) => {
				if (!evt.clipboardData?.items || evt.defaultPrevented) return;

				let file: File | null = null;
				for (const item of evt.clipboardData.items) {
					if (item.kind === "file") {
						file = item.getAsFile();
						break;
					}
				}

				if (!file || !isValidImageFile(file)) return;

				evt.preventDefault();
				return handleDropPasteEvent(this, file, editor);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("editor-drop", async (evt: DragEvent, editor: Editor) => {
				if (!evt.dataTransfer?.files?.[0] || evt.defaultPrevented) return;

				const file = evt.dataTransfer.files[0];
				if (!file || !isValidImageFile(file)) return;

				evt.preventDefault();
				return handleDropPasteEvent(this, file, editor);
			}),
		);
	}
}
