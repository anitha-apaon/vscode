/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

//@ts-check

(function () {

	/**
	 * @param {typeof import('path')} path
	 * @param {typeof import('fs')} fs
	 * @param {typeof import('../common/performance')} perf
	 */
	function factory(path, fs, perf) {

		//#region fs helpers

		/**
		 * @param {string} path
		 */
		async function exists(path) {
			try {
				await fs.promises.access(path);

				return true;
			} catch {
				return false;
			}
		}

		/**
		 * @param {string} path
		 */
		function touch(path) {
			const date = new Date();
			return fs.promises.utimes(path, date, date);
		}

		/**
		 * @param {string} path
		 */
		function mkdirp(path) {
			return fs.promises.mkdir(path, { recursive: true });
		}

		/**
		 * @param {string} path
		 */
		function rimraf(path) {
			return fs.promises.rm(path, { recursive: true, force: true, maxRetries: 3 });
		}

		/**
		 * @param {string} path
		 */
		function readFile(path) {
			return fs.promises.readFile(path, 'utf-8');
		}

		/**
		 * @param {string} path
		 * @param {string} content
		 */
		function writeFile(path, content) {
			return fs.promises.writeFile(path, content, 'utf-8');
		}

		//#endregion

		/**
		 * @param {string} userDataPath
		 * @returns {Promise<import('./nls').ILanguagePacks | undefined>}
		 */
		async function getLanguagePackConfigurations(userDataPath) {
			const configFile = path.join(userDataPath, 'languagepacks.json');
			try {
				return JSON.parse(await readFile(configFile));
			} catch (err) {
				return undefined; // Do nothing. If we can't read the file we have no language pack config.
			}
		}

		/**
		 * @param {import('./nls').ILanguagePacks} languagePacks
		 * @param {string | undefined} locale
		 */
		function resolveLanguagePackLocale(languagePacks, locale) {
			try {
				while (locale) {
					if (languagePacks[locale]) {
						return locale;
					}

					const index = locale.lastIndexOf('-');
					if (index > 0) {
						locale = locale.substring(0, index);
					} else {
						return undefined;
					}
				}
			} catch (error) {
				console.error('Resolving language pack configuration failed.', error);
			}

			return undefined;
		}

		/**
		 * @param {string} userLocale
		 * @param {string} osLocale
		 * @param {boolean} [pseudo]
		 * @returns {import('./nls').INLSConfiguration}
		 */
		function defaultNLSConfiguration(userLocale, osLocale, pseudo) {
			perf.mark('code/didGenerateNls');

			return { userLocale, osLocale, availableLanguages: {}, pseudo };
		}

		/**
		 * @param {import('./nls').IResolveNLSConfigurationContext} context
		 * @returns {Promise<import('./nls').INLSConfiguration>}
		 */
		async function resolveNLSConfiguration({ userLocale, osLocale, userDataPath, commit, nlsMetadataPath }) {
			perf.mark('code/willGenerateNls');

			if (
				process.env['VSCODE_DEV'] ||
				userLocale === 'pseudo' ||
				userLocale === 'en' || userLocale === 'en-us' ||
				!commit
			) {
				return defaultNLSConfiguration(userLocale, osLocale, userLocale === 'pseudo' ? true : undefined);
			}

			try {
				const languagePacks = await getLanguagePackConfigurations(userDataPath);
				if (!languagePacks) {
					return defaultNLSConfiguration(userLocale, osLocale);
				}

				const resolvedLocale = resolveLanguagePackLocale(languagePacks, userLocale);
				if (!resolvedLocale) {
					return defaultNLSConfiguration(userLocale, osLocale);
				}

				const initialUserLocale = userLocale;
				userLocale = resolvedLocale;

				const languagePack = languagePacks[userLocale];
				const mainLanguagePackPath = languagePack?.translations?.['vscode'];
				if (
					!languagePack ||
					typeof languagePack.hash !== 'string' ||
					!languagePack.translations ||
					typeof mainLanguagePackPath !== 'string' ||
					!(await exists(mainLanguagePackPath))
				) {
					return defaultNLSConfiguration(initialUserLocale, osLocale);
				}

				const languagePackId = `${languagePack.hash}.${userLocale}`;
				const globalLanguagePackCachePath = path.join(userDataPath, 'clp', languagePackId);
				const commitLanguagePackCachePath = path.join(globalLanguagePackCachePath, commit);
				const translationMessagesFile = path.join(commitLanguagePackCachePath, 'nls.messages.json');
				const translationsConfigFile = path.join(globalLanguagePackCachePath, 'tcf.json');
				const languagePackCorruptedFile = path.join(globalLanguagePackCachePath, 'corrupted.info');

				if (await exists(languagePackCorruptedFile)) {
					await rimraf(globalLanguagePackCachePath); // delete corrupted cache folder
				}

				/** @type {import('./nls').IInternalNLSConfiguration} */
				const result = {
					userLocale: initialUserLocale,
					osLocale,
					availableLanguages: { '*': userLocale },
					_languagePackId: languagePackId,
					_translationsConfigFile: translationsConfigFile,
					_cacheRoot: globalLanguagePackCachePath,
					_resolvedLanguagePackCoreLocation: commitLanguagePackCachePath,
					_corruptedFile: languagePackCorruptedFile
				};

				if (await exists(commitLanguagePackCachePath)) {
					touch(commitLanguagePackCachePath).catch(() => { }); // We don't wait for this. No big harm if we can't touch
					perf.mark('code/didGenerateNls');
					return result;
				}

				/** @type {[unknown, Array<[string, string[]]>, string[], { contents: Record<string, Record<string, string>> }]} */
				//                          ^moduleId ^nlsKeys                               ^moduleId      ^nlsKey ^nlsValue
				const [
					,
					nlsDefaultKeys,
					nlsDefaultMessages,
					nlsPackdata
				] = await Promise.all([
					mkdirp(commitLanguagePackCachePath),
					JSON.parse(await readFile(path.join(nlsMetadataPath, 'nls.keys.json'))),
					JSON.parse(await readFile(path.join(nlsMetadataPath, 'nls.messages.json'))),
					JSON.parse(await readFile(mainLanguagePackPath))
				]);

				/** @type {string[]} */
				const nlsResult = [];

				// We expect NLS messages to be in a flat array in sorted order as they
				// where produced during build time. We use `nls.keys.json` to know the
				// right order and then lookup the related message from the translation.
				// If a translation does not exist, we fallback to the default message.

				let nlsIndex = 0;
				for (const [moduleId, nlsKeys] of nlsDefaultKeys) {
					const moduleTranslations = nlsPackdata.contents[moduleId];
					for (const nlsKey of nlsKeys) {
						nlsResult.push(moduleTranslations?.[nlsKey] || nlsDefaultMessages[nlsIndex]);
						nlsIndex++;
					}
				}

				await Promise.all([
					writeFile(translationMessagesFile, JSON.stringify(nlsResult)),
					writeFile(translationsConfigFile, JSON.stringify(languagePack.translations))
				]);

				perf.mark('code/didGenerateNls');

				return result;
			} catch (error) {
				console.error('Generating translation files failed.', error);
			}

			return defaultNLSConfiguration(userLocale, osLocale);
		}

		return {
			resolveNLSConfiguration
		};
	}

	if (typeof define === 'function') {
		// amd
		define(['path', 'fs', 'vs/base/common/performance'], function (/** @type {typeof import('path')} */ path, /** @type {typeof import('fs')} */ fs, /** @type {typeof import('../common/performance')} */ perf) { return factory(path, fs, perf); });
	} else if (typeof module === 'object' && typeof module.exports === 'object') {
		// commonjs
		const path = require('path');
		const fs = require('fs');
		const perf = require('../common/performance');
		module.exports = factory(path, fs, perf);
	} else {
		throw new Error('vs/base/node/nls defined in UNKNOWN context (neither requirejs or commonjs)');
	}
})();