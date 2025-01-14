import assert from 'node:assert'
import sharp from 'sharp'
import { optimize as svgo } from 'svgo'
import { imageInformation } from '@jcayzac/image-information'
import { baseService } from 'astro/assets'
import type { ImageMetadata, LocalImageService } from 'astro'
import { AstroError } from 'astro/errors'
import type { LocalImageServiceConfig, PrivateConfig, ResolvedTransform, Transform } from './config'

function isImageMetadata(src: any): src is ImageMetadata {
	return typeof src === 'object' && typeof src.src === 'string' && 'width' in src && 'height' in src && 'format' in src
}

// Keep for compatibility with Astro documentation
// See https://docs.astro.build/en/guides/images/#quality
const qualityTable: { [k: string]: number } = {
	low: 50,
	mid: 70,
	high: 80,
	max: 100, // lossless
}

const service: LocalImageService<PrivateConfig> = {
	propertiesToHash: ['src', 'width', 'height', 'format', 'quality'],

	validateOptions: async (options: Transform, config: LocalImageServiceConfig) => {
		const { src } = options
		const { publicDir, assets, outDir, defaultFormat = 'avif' } = config.service.config
		if (!publicDir || !assets || !outDir) {
			throw new AstroError(`This image service cannot be used directly, you must use the provided Astro integration!`)
		}

		if (!src) {
			throw new AstroError(`\`src\` is missing`)
		}

		if (typeof src === 'string') {
			// Not an ESM-imported image
			const isAbsoluteURL = /^(?:\w+:)?\/\//.test(src) // absolute (maybe protocol-relative) URLs
			const isPublicAsset = /^\/(?![@/])/.test(src) // all /… except /@… and //…
			const isBundledAsset = src.startsWith(`/${assets}/`) // /_astro/…
			if (!isAbsoluteURL && !isBundledAsset && !isPublicAsset) {
				throw new AstroError(`Local image not correctly imported: "${src}"`)
			}

			if (!options.width || !options.height) {
				// Try inferring intrinsic dimensions from the image
				let url: URL | undefined
				if (isAbsoluteURL) {
					// Handle protocol-relative URLs as https://
					url = src.startsWith('//') ? new URL(`https://${src}`) : new URL(src)
				}
				else if (isBundledAsset) {
					// Look into dist/_astro
					url = new URL(src, outDir)
				}
				else {
					assert.ok(isPublicAsset)
					// Look into public/
					url = new URL(src, publicDir)
				}
				const info = await imageInformation(url)
				if (info) {
					options.width = info.width
					options.height = info.height
				}
				else {
					// Couldn't infer dimensions :-/
					throw new AstroError(`\`width\` and \`height\` must be specified for "${src}"`)
				}
			}
		}
		else if (isImageMetadata(src)) {
			if (src.format === 'svg' && options.format === undefined) {
				// Default output format for SVG is SVG
				options.format = 'svg'
			}
			else if (src.format !== 'svg' && options.format === 'svg') {
				// Non-SVG input cannot be converted to SVG
				throw new AstroError(`Cannot transform from "${src.format}" to "svg"`)
			}
		}
		else {
			throw new AstroError(`Expected \`src\` to be of type \`string | ImageMetadata\`, but got \`${typeof src}\` instead`)
		}

		if (options.densities && options.widths) {
			throw new AstroError(`\`densities\` and \`widths\` cannot be used together`)
		}

		if (options.width) {
			options.width = Math.round(options.width)
		}

		if (options.height) {
			options.height = Math.round(options.height)
		}

		if (!options.format) {
			options.format = defaultFormat
		}
		else if (options.format === 'jpg') {
			options.format = 'jpeg'
		}

		return options
	},

	getURL: async (options: Transform, config: LocalImageServiceConfig) => {
		// Grab the image endpoint's path from the base service
		let base = baseService.getURL(options, config)
		if (base instanceof Promise) {
			base = await base
		}
		// normalize and remove the query string
		const path = new URL(base, 'http://localhost').pathname

		// Build our query string
		const query = new URLSearchParams()
		query.append('href', typeof options.src === 'string' ? options.src : options.src.src)

		if (options.width) {
			query.append('w', `${options.width}`)
		}

		if (options.height) {
			query.append('h', `${options.height}`)
		}

		if (options.quality) {
			query.append('q', `${options.quality}`)
		}

		if (options.format) {
			query.append('f', options.format)
		}

		return `${path}?${query}`
	},

	parseURL: ({ searchParams: query }, _config: LocalImageServiceConfig) => {
		const src = query.get('href')
		if (!src) {
			return undefined
		}

		const width = query.get('w')
		const height = query.get('h')
		const quality = query.get('q')
		const format = query.get('f')
		const lossless = query.get('lossless')

		return {
			src,
			width: width ? Number.parseInt(width, 10) : undefined,
			height: height ? Number.parseInt(height, 10) : undefined,
			quality,
			format,
			lossless: lossless === '1',
		}
	},

	getHTMLAttributes: (options: Transform, _config: LocalImageServiceConfig) => {
		const { width, height } = getTargetDimensions(options)

		const {
			src: _src,
			width: _width,
			height: _height,
			format: _format,
			formats: _formats,
			quality: _quality,
			densities: _densities,
			widths: _widths,
			loading = 'lazy',
			decoding = 'async',
			...attributes
		} = options
		return { ...attributes, width, height, loading, decoding }
	},

	getSrcSet: (options: Transform, _config: LocalImageServiceConfig) => {
		const format = options.format ?? 'avif'
		const mimeType = ({
			svg: 'image/svg+xml',
			ico: 'image/vnd.microsoft.icon',
		} as Record<string, string>)[format] ?? `image/${format}`

		const [imageWidth, maxWidth]
			= typeof options.src === 'string'
				? [options.width, Infinity]
				: [options.src.width, options.src.width]

		const allWidths = []
		const { widths, densities } = options
		if (densities) {
			const { width } = getTargetDimensions(options)
			if (width !== undefined) {
				const densityValues = densities.map(density => typeof density === 'number' ? density : Number.parseFloat(density)).sort()
				allWidths.push(
					...densityValues.map((density, index) => ({
						maxTargetWidth: Math.min(Math.round(width * density), maxWidth),
						descriptor: `${densityValues[index]}x`,
					})),
				)
			}
		}
		else if (widths) {
			allWidths.push(
				...widths.map(width => ({
					maxTargetWidth: Math.min(width, maxWidth),
					descriptor: `${width}w`,
				})),
			)
		}

		const {
			width: _ignoredWidth,
			height: _ignoredHeight,
			...transformWithoutDimensions
		} = options

		return allWidths.reduce<any>((srcSet, { maxTargetWidth, descriptor }) => {
			const srcSetTransform = { ...transformWithoutDimensions }

			if (maxTargetWidth !== imageWidth) {
				srcSetTransform.width = maxTargetWidth
			}
			else {
				if (options.width && options.height) {
					srcSetTransform.width = options.width
					srcSetTransform.height = options.height
				}
			}

			srcSet.push({
				transform: srcSetTransform,
				descriptor,
				attributes: {
					type: mimeType,
				},
			})

			return srcSet
		}, [])
	},

	async transform(inputBuffer, transform: ResolvedTransform, _config: LocalImageServiceConfig) {
		// validateOptions() currently guarantees that inputBuffer is an SVG
		// if "format" is "svg", so we can safely assume that here.
		if (transform.format === 'svg') {
			const { data } = svgo(new TextDecoder().decode(inputBuffer), {
				multipass: true,
			})
			return {
				data: new TextEncoder().encode(data),
				format: 'svg',
			}
		}

		// Initialize sharp with the input buffer.
		const result = sharp(inputBuffer, {
			failOn: 'error',
			pages: -1, // convert all pages
			limitInputPixels: false,
		})

		const metadata = await result.metadata()
		const colorspace = (metadata.space ?? 'srgb') as string
		const isHdr = colorspace === 'rgb16'
		const icc = metadata.icc

		// Always call rotate() first to ensure that the image is properly oriented.
		result.rotate()

		// Resize, allowing the image ratio to change if requested.
		if (typeof transform.width === 'number' || typeof transform.height === 'number') {
			const params: sharp.ResizeOptions = {}
			if (typeof transform.width === 'number') {
				params.width = Math.round(transform.width)
			}
			if (typeof transform.height === 'number') {
				params.height = Math.round(transform.height)
			}
			result.resize(params)
		}

		// Convert to the requested format.
		if (transform.format) {
			// TODO: use metadata to determine if the image is HDR, and if so, set
			// the pipeline colorspace to 'rgb16' and the metadata to 'icc: p3'.
			//
			let options: any = {}

			// Only override Sharp's default quality if a value is provided.
			const quality = typeof transform.quality === 'number' ? transform.quality : qualityTable[transform.quality ?? '']
			if (quality !== undefined) {
				options.quality = quality
			}

			if (isHdr && transform.format !== 'png') {
				console.warn(`Warning: Sharp does not support writing HDR .${transform.format} images. Converting to SDR…`)
			}

			// Set some sane defaults.
			switch (transform.format) {
				case 'avif':
					options = {
						...options,
						bitdepth: 8,
						lossless: options.quality === 100,
						// effort: 9, // too slow!
					} satisfies sharp.AvifOptions
					break

				case 'webp':
					options = {
						...options,
						lossless: options.quality === 100,
						// effort: 6, // too slow!
					} satisfies sharp.WebpOptions
					break

				case 'png':
					options = {
						...options,
						// compressionLevel: 9, // too slow!
					} satisfies sharp.PngOptions
					break

				case 'jpeg':
					options = {
						...options,
						mozjpeg: true,
					} satisfies sharp.JpegOptions
					break
			}

			result.toFormat(transform.format, options)
		}

		if (isHdr && transform.format === 'png') {
			// Only PNG supports HDR images for now
			result.pipelineColorspace('rgb16')
		}

		if (icc) {
			result.keepIccProfile()
		}

		const { data, info: { format } } = await result.toBuffer({
			resolveWithObject: true,
		})
		return {
			data,
			format,
		}
	},
}

export default service

function getTargetDimensions(options: Transform) {
	let { width, height } = options
	if (isImageMetadata(options.src)) {
		const aspectRatio = options.src.width / options.src.height
		if (height && !width) {
			width = Math.round(height * aspectRatio)
		}
		else if (width && !height) {
			height = Math.round(width / aspectRatio)
		}
		else if (!width && !height) {
			width = options.src.width
			height = options.src.height
		}
	}
	return {
		width,
		height,
	}
}
