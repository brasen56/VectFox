# SigMap Query Context
Generated: 2026-05-24T23:59:27.745Z

## core\content-vectorization.js
```
export function resolveEffectiveSettings(callerSettings) → object
export async function vectorizeContent({ contentType, source, settings, abortSignal = null, continueMode = false, startFromMessage = 1 }) → Promise<{success: boolean
export async function resolveAndPrepareContent(contentType, source, settings) → Promise<{text: string, ..
export async function deleteContentCollection(collectionId, callerSettings = null)
async function resolveSource(contentType, source)
async function loadSelectedSource(contentType, sourceId)
async function loadLorebookContent(lorebookName, context)
async function loadCharacterContent(characterId, context)
async function prepareContent(contentType, rawContent, settings, startFromMessage = 1)
function prepareCharacterContent(rawContent, settings)
function prepareChatContent(rawContent, settings, startFromMessage = 1)
function prepareUrlContent(rawContent, settings)
function prepareDocumentContent(rawContent, settings)
function prepareWikiContent(rawContent, settings)
function prepareYouTubeContent(rawContent, settings)
function generateCollectionId(contentType, source, settings)
function enrichChunks(chunks, contentType, source, settings, preparedContent, VectFoxSettings)
```

## diagnostics\configuration.js
```
export function checkChatEnabled(settings)
export function checkChunkSize(settings)
export function checkScoreThreshold(settings)
export function checkInsertQueryCounts(settings)
export async function checkChatVectors(settings)
export function checkVisualizerApiReadiness(settings)
export function checkCollectionIdFormat()
export function checkConditionalActivationModule()
export async function checkHashCollisionRate(settings)
export function checkChatMetadataIntegrity()
export async function checkConditionRuleValidity(settings)
export async function checkCollectionRegistryStatus(settings)
export async function checkPromptContextConfig(settings)
export function checkPNGExportCapability()
```

## core\chat-vectorization.js
```
export async function synchronizeChat(settings, batchSize = 5, triggerEvent = null) → Promise<object>
export async function rearrangeChat(chat, settings, type, { dryRun = false, testMessage = null } = {})
export async function vectorizeAll(settings, batchSize, abortSignal = null)
function getStringHash(str) → number
function getTextWithoutAttachments(message) → string
async function groupMessagesByStrategy(messages, strategy, batchSize = 4, keywordLevel = 'balanced', settings = {})
async function applyChunkConditions(chunks, chat, settings) → object[]
function trackChunkActivation(hash, messageCount)
async function rerankWithBananaBread(query, chunks, settings) → Promise<Array>
function gatherCollectionsToQuery(settings) → string[]
function buildSearchQuery(chat, settings) → string
async function queryAndMergeCollections(activeCollections, queryText, settings, chat, debugData) → Promise<object[]>
async function expandSummaryChunks(chunks, activeCollections, settings, debugData) → Promise<object[]>
function applyThresholdFilter(chunks, threshold, debugData) → object[]
async function applyConditionsStage(chunks, chat, settings, debugData) → Promise<object[]>
async function applyGroupsAndLinksStage(chunks, activeCollections, settings, debugData) → Promise<object[]>
function deduplicateChunks(chunks, chat, settings, debugData) → {toInject: object[], skip
function buildNestedInjectionText(chunks, settings) → string
function resolveChunkInjectionPosition(chunk, settings) → {position: number, depth:
function injectChunksIntoPrompt(chunksToInject, settings, debugData) → {verified: boolean, text:
```

## core\core-vector-api.js
```
class DynamicRateLimiter
constructor()
async execute(fn, settings) → Promise<any>
if(maxCalls <= 0)
if(this.timestamps.length >= maxCalls)
if(waitTime > 0)
export function getVectorsRequestBody(args = {}, settings) → object
export async function getAdditionalArgs(items, settings, onProgress = null) → Promise<object>
export function throwIfSourceInvalid(settings)
export async function getSavedHashes(collectionId, settings, includeMetadata = false) → Promise<number[]|{hashes:
export async function insertVectorItems(collectionId, items, settings, onProgress = null, abortSignal = null) → Promise<void>
export async function deleteVectorItems(collectionId, hashes, settings) → Promise<void>
export async function queryCollection(collectionId, searchText, topK, settings, filters = {}) → Promise<{ hashes: number[
export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) → Promise<Record<string, {
export async function queryActiveCollections(collectionIds, searchText, topK, threshold, settings, context) → Promise<Record<string, {
export async function purgeVectorIndex(collectionId, settings) → Promise<boolean>
export async function purgeFileVectorIndex(collectionId, settings) → Promise<void>
export async function purgeAllVectorIndexes(settings) → Promise<void>
export async function listChunks(collectionId, settings, options = {}) → Promise<{items: Array<{ha
export async function updateChunkText(collectionId, hash, newText, settings)
```

## core\agentic-retrieval.js
```
export async function retrieveEventsWithAgent(params) → Promise<{events: object[]
export function _resolveAgenticLLMConfig(settings = {})
export function _validatePlannerFilters(raw, settings)
async function _callPlanner({ systemPrompt, userMessage, llmCfg, timeoutMs })
function _getRecentChatForPlanner(settings)
function _firstNWords(text, n)
function _validateAndTrimQueries(queries, maxQueries)
```
