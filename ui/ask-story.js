/** Manual research panel. All model and stored text is rendered as text, never HTML. */
import { askStory, STORY_LIMITS } from '../core/story-research.js';
import { completeStoryAnswer } from '../core/story-answer-llm.js';

const failureLabels = { retrieval: 'retrieval', provider: 'provider', malformed_json: 'malformed JSON / answer structure',
    invalid_citations: 'invalid citations', output_truncation: 'output truncation' };

export function openAskStoryPanel(settings, saveSettings) {
    const previous = document.getElementById('VectFox_ask_story_panel');
    if (previous) { previous.scrollIntoView?.({ block: 'nearest' }); return; }
    const host = document.createElement('section');
    host.id = 'VectFox_ask_story_panel';
    host.className = 'vectfox-ask-story';
    const element = (tag, text, parent = host) => {
        const node = document.createElement(tag);
        if (text != null) node.textContent = text;
        parent.append(node);
        return node;
    };
    element('h3', 'Ask the Story');
    const label = element('label');
    const enabled = element('input', null, label);
    enabled.type = 'checkbox';
    enabled.checked = settings.ask_story_enabled === true;
    label.append(document.createTextNode(' Enable manual Ask requests (off by default)'));
    const scope = element('p');
    const scopeLabel = element('label', 'Research scope');
    const scopeKind = element('select', null, scopeLabel);
    for (const [value, text] of [['current_chat', 'Current chat'], ['selected_collections', 'Selected collections']]) {
        const option = element('option', text, scopeKind);
        option.value = value;
    }
    const collectionLabel = element('label', 'Select 1–20 event collections (Ctrl/Cmd-click for multiple)');
    const collections = element('select', null, collectionLabel);
    collections.multiple = true;
    collections.size = 5;
    collections.setAttribute('aria-label', 'Event collections');
    collectionLabel.hidden = true;
    element('small', 'Selected archives may have unknown provenance; unavailable originals remain unresolved.', collectionLabel);
    const limits = element('small', `One answer call; no planning or retries. Semantic retrieval may make embedding requests (at most one query per selected collection). Up to ${STORY_LIMITS.candidates} candidates, ${STORY_LIMITS.evidence} evidence records, ${STORY_LIMITS.evidenceChars} evidence characters; 2048 output tokens. No lorebook writes or context injection.`);
    limits.style.display = 'block';
    const questionLabel = element('label', 'Research question');
    const question = element('textarea');
    question.id = 'VectFox_story_question';
    questionLabel.htmlFor = question.id;
    question.maxLength = STORY_LIMITS.questionChars;
    question.rows = 3;
    question.className = 'vectfox-input';
    question.placeholder = 'How did Alex meet Ranger?';
    const actions = element('div');
    const button = (text, action) => {
        const node = element('button', text, actions);
        node.type = 'button';
        node.className = 'menu_button';
        node.addEventListener('click', action);
        return node;
    };
    const status = element('p');
    status.setAttribute('role', 'status');
    const output = element('div');
    let controller = null, answer = null, activeToken = null, closed = false, operation = 0;
    let collectionSignature = '';
    const api = () => window.VectFoxAPI;
    const refresh = () => {
        const state = api()?.getStatus();
        const available = state?.available_collections || state?.effective_collections || [];
        const signature = JSON.stringify(available);
        if (signature !== collectionSignature) {
            const selected = new Set([...collections.selectedOptions].map(option => option.value));
            collections.replaceChildren();
            for (const collection of available) {
                const option = element('option', collection.registryKey || collection.collectionId, collections);
                option.value = collection.registryKey || collection.collectionId;
                option.selected = selected.has(option.value);
            }
            collectionSignature = signature;
        }
        const valid = state?.ready && (!activeToken || activeToken === state.scope_token);
        if (!valid && (controller || answer)) {
            controller?.abort();
            answer = null;
            output.replaceChildren();
            status.textContent = 'Story scope changed or became unavailable. Ask again.';
        }
        const explicit = scopeKind.value === 'selected_collections';
        const selected = [...collections.selectedOptions].map(option => option.value);
        scope.textContent = `Model: ${settings.chat_model || '(not configured)'} (${settings.chat_provider || 'openrouter'}). Scope: ${explicit ? 'selected collections' : 'current chat'}; collections: ${(explicit ? selected : state?.effective_collections?.map(c => c.collectionId))?.join(', ') || '(none)'}. VectFox: ${state?.state || 'unavailable'}.`;
        ask.disabled = !enabled.checked || !!controller || !state?.ready || (explicit && (!selected.length || selected.length > 20));
        cancel.disabled = !controller;
        copy.disabled = !answer;
    };
    const render = result => {
        output.replaceChildren();
        element('strong', result.status === 'failed' ? 'Answer generation failed — retrieval succeeded' : result.status === 'no_evidence' ? 'No relevant evidence' : result.status === 'partial' ? 'Partial answer' : 'Answer', output);
        if (result.gap) element('p', result.gap, output);
        const coverage = result.coverage;
        if (coverage.semantic?.unavailable?.length) element('p', 'Semantic retrieval was unavailable for some or all collections; lexical/chronological results may miss paraphrases.', output);
        element('p', `Coverage: ${coverage.returned_count} retrieved, ${coverage.evidence_count} shown to model. ${coverage.search_policy}. ${coverage.sampled ? 'History sampled. ' : ''}${coverage.truncated ? 'Search/evidence truncated. ' : ''}${coverage.partial ? 'Some records unavailable or sources unknown. ' : ''}${coverage.sources_unavailable ? 'Some originals unavailable or unverified. ' : ''}${result.calls} generation call(s).`, output);
        const exclusionReasons = { unknown_source_chat: 'their source chat is unknown',
            other_source_chat: 'they belong to another source chat', active_duplicate: 'they are marked as active duplicates' };
        for (const exclusion of coverage.exclusions || []) {
            element('p', `${exclusion.count} entries excluded because ${exclusionReasons[exclusion.reason] || exclusion.reason}.`, output);
        }
        if (coverage.unknown_source_chat_included_count) element('p', `${coverage.unknown_source_chat_included_count} entries with unknown source chats included in the selected archives; their provenance remains unverified.`, output);
        for (const unavailable of coverage.unavailable || []) element('p', `Collection unavailable: ${unavailable.collection_id || unavailable.collection_key || 'unknown'} — ${unavailable.reason || unavailable.code}.`, output);
        if (coverage.source_resolution_error) element('p', `Source resolution unavailable: ${coverage.source_resolution_error}`, output);
        element('small', 'Citations identify supplied evidence, not proof that the model interpreted it correctly. Inspect the summaries below.', output);
        const blocks = [...result.claims];
        const cited = new Set(result.claims.flatMap(claim => claim.event_refs));
        const remaining = result.evidence.filter(event => !cited.has(event.event_ref));
        if (remaining.length) blocks.push({ sentence: 'Retrieved evidence (not accepted answer claims)', event_refs: remaining.map(event => event.event_ref) });
        for (const claim of blocks) {
            const block = element('div', null, output);
            element('p', claim.sentence, block);
            for (const ref of claim.event_refs) {
                const event = result.evidence.find(item => item.event_ref === ref);
                const details = element('details', null, block);
                element('summary', `${event.event_id} · ${event.source_chat_id || 'unknown chat'} · source ${event.source_window_start ?? '?'}`, details);
                element('p', `Stored summary: ${event.summary || ''}`, details);
                if (event.DateTime) element('p', `Stored story date (DateTime): ${event.DateTime}`, details);
                if (event.scene_time) element('p', `Stored scene time: ${event.scene_time}`, details);
                if (event.cause) element('p', `Cause: ${event.cause}`, details);
                if (event.result) element('p', `Result: ${event.result}`, details);
                element('small', ref, details);
                for (const sourceRef of event.source_refs || []) {
                    const source = result.sources.find(item => item.ref === sourceRef.ref);
                    if (source?.status === 'verified' && source.message) {
                        const original = element('details', null, details);
                        element('summary', source.recovered_ils ? 'Inspect recovered ILS original' : 'Inspect verified original message', original);
                        element('pre', `${source.message.name}: ${source.message.mes}`, original);
                    } else element('p', `Original unavailable: ${source?.status || 'unresolved'}${source?.reason ? ` (${source.reason})` : ''}`, details);
                }
            }
        }
    };
    const ask = button('Ask', async () => {
        controller = new AbortController();
        const request = controller;
        const run = ++operation;
        const config = { ...settings };
        const researchQuestion = question.value;
        activeToken = api()?.getStatus().scope_token;
        answer = null;
        output.replaceChildren();
        status.textContent = 'Researching stored events…';
        refresh();
        try {
            const result = await askStory({ api: api(), question: researchQuestion,
                scope: scopeKind.value === 'selected_collections'
                    ? { kind: 'selected_collections', collections: [...collections.selectedOptions].map(option => option.value) }
                    : { kind: 'current_chat' },
                complete: (prompt, signal) => completeStoryAnswer(prompt, config, signal), signal: request.signal });
            if (closed || run !== operation) return;
            request.signal.throwIfAborted();
            if (!enabled.checked || api().getStatus().scope_token !== result.scope_token) throw new Error('Story scope changed. Ask again.');
            answer = { ...result, question: researchQuestion };
            render(result);
            status.textContent = 'Research complete.';
        } catch (error) {
            if (!closed && run === operation) {
                const valid = !request.signal.aborted && enabled.checked && api()?.getStatus().ready
                    && api().getStatus().scope_token === activeToken;
                if (valid && error.result?.scope_token === activeToken) {
                    answer = { ...error.result, question: researchQuestion };
                    render(error.result);
                }
                status.textContent = request.signal.aborted ? 'Request cancelled; no answer accepted.'
                    : `Research failed${error.stage ? ` [${failureLabels[error.stage] || error.stage}]` : ''}: ${error.message}`;
            }
        } finally {
            if (!closed && run === operation) { controller = null; refresh(); }
        }
    });
    const cancel = button('Cancel', () => { controller?.abort(); status.textContent = 'Cancelling request…'; });
    const copy = button('Copy', async () => {
        refresh();
        if (!answer) return;
        try {
            await navigator.clipboard.writeText([answer.question, ...answer.claims.map(c => `${c.sentence} [${c.event_refs.join(', ')}]`),
                answer.failure ? `Failure [${failureLabels[answer.failure.stage]}]: ${answer.failure.message}` : '',
                answer.gap, `Coverage: ${JSON.stringify(answer.coverage)}`,
                ...answer.evidence.map(event => `Stored evidence [${event.event_ref}]: ${JSON.stringify(event)}`)].filter(Boolean).join('\n\n'));
            if (!closed) status.textContent = 'Copied research, evidence, citations, and coverage.';
        } catch { if (!closed) status.textContent = 'Clipboard unavailable.'; }
    });
    button('Close', () => { closed = true; controller?.abort(); clearInterval(poll); host.remove(); });
    enabled.addEventListener('change', () => {
        settings.ask_story_enabled = enabled.checked;
        saveSettings();
        if (!enabled.checked) { controller?.abort(); answer = null; output.replaceChildren(); }
        refresh();
    });
    const changeScope = () => {
        operation++;
        controller?.abort();
        controller = null;
        answer = null;
        activeToken = null;
        output.replaceChildren();
        status.textContent = 'Research scope changed. Ask again.';
        collectionLabel.hidden = scopeKind.value !== 'selected_collections';
        refresh();
    };
    scopeKind.addEventListener('change', changeScope);
    collections.addEventListener('change', changeScope);
    const poll = setInterval(() => {
        if (!host.isConnected) { closed = true; controller?.abort(); clearInterval(poll); return; }
        refresh();
    }, 500);
    document.getElementById('VectFox_ask_story').closest('.vectfox-card')?.append(host);
    if (!host.isConnected) document.getElementById('VectFox_ask_story').parentElement.after(host);
    refresh();
    host.scrollIntoView?.({ block: 'nearest' });
    question.focus();
}