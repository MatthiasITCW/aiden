# Graph Report - DevOS  (2026-05-07)

## Corpus Check
- 654 files · ~2,518,294 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3635 nodes · 6792 edges · 86 communities detected
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 529 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 103|Community 103]]
- [[_COMMUNITY_Community 116|Community 116]]

## God Nodes (most connected - your core abstractions)
1. `resolveAidenPaths()` - 93 edges
2. `summarize()` - 77 edges
3. `Display` - 76 edges
4. `handleCommand()` - 48 edges
5. `AidenAgent` - 43 edges
6. `SkinEngine` - 40 edges
7. `ensureAidenDirsExist()` - 40 edges
8. `planWithLLM()` - 39 edges
9. `ToolRegistry` - 37 edges
10. `runTest()` - 34 edges

## Surprising Connections (you probably didn't know these)
- `handleCommand()` --calls--> `clearHonchoProfile()`  [INFERRED]
  cli\aiden.ts → core\userProfile.ts
- `handleCommand()` --calls--> `buildSdkSurface()`  [INFERRED]
  cli\aiden.ts → core\aidenSdk.ts
- `handleCommand()` --calls--> `getSdkMethods()`  [INFERRED]
  cli\aiden.ts → core\aidenSdk.ts
- `handleCommand()` --calls--> `getSdkNamespaces()`  [INFERRED]
  cli\aiden.ts → core\aidenSdk.ts
- `skill()` --calls--> `parseSkillContent()`  [INFERRED]
  tests\v4\skillsConfig.test.ts → core\v4\skillSpec.ts

## Communities (192 total, 23 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.01
Nodes (122): buildCtx(), captured(), captureTutorial(), loadOAuthProvider(), openOAuthBrowserUrl(), OAuthProviderRegistry, OAuthProviderRuntime, captureTutorial() (+114 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (177): getDashboardHTML(), aidenToolToMCP(), buildInputSchema(), createApiServer(), extractChatMessageContent(), fetchProviderResponse(), handleChatError(), raceProviders() (+169 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (52): preArmIntent(), debugEnabled(), debugLog(), extractSkillViewRequiredTools(), SkillEnforcementTracker, buildGroq(), buildSlots(), buildTogether() (+44 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (66): redactSecrets(), subsectionFor(), Spinner, check_1_parchment_wide(), check_2_parchment_uniform_width(), check_3_parchment_pipe_alignment(), check_4_no_diagonals(), check_5_plain_fallback() (+58 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (48): addMcpPrefix(), sanitizeIdentity(), stripMcpPrefix(), detect(), formatUserAgent(), getClaudeCliUserAgent(), __resetForTests(), __setRunnerForTests() (+40 more)

### Community 5 - "Community 5"
Cohesion: 0.03
Nodes (71): detectCaptchaMarkers(), runInSandbox(), clickMouse(), executePowerShell(), executeWithFallback(), executeWithVisionRetry(), focusWindow(), getScreenSize() (+63 more)

### Community 6 - "Community 6"
Cohesion: 0.05
Nodes (79): run(), run(), run(), run(), getRecordsSnapshot(), run(), run(), run() (+71 more)

### Community 7 - "Community 7"
Cohesion: 0.03
Nodes (60): main(), LivePulse, getPid(), isServiceRunning(), startBackgroundService(), stopService(), buildCapabilityProfile(), detectOllamaLocalLLM() (+52 more)

### Community 8 - "Community 8"
Cohesion: 0.03
Nodes (32): makeFakeBlessed(), makeOpts(), authBadge(), defaultPrompts(), modelChoice(), providerChoice(), runModelPicker(), answer() (+24 more)

### Community 9 - "Community 9"
Cohesion: 0.04
Nodes (77): apiDelete(), apiFetch(), apiPost(), applyTheme(), clearDropdown(), cols(), ctxBar(), ctxColor() (+69 more)

### Community 10 - "Community 10"
Cohesion: 0.02
Nodes (11): DiscordAdapter, EmailAdapter, IMessageAdapter, SignalAdapter, SlackAdapter, chunkSms(), TwilioAdapter, WebhookAdapter (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.03
Nodes (21): filterFlaggedSkills(), kebabFromText(), SkillTeacher, makeManager(), makeTeacher(), verbForToolset(), createNullLogger(), normaliseTags() (+13 more)

### Community 12 - "Community 12"
Cohesion: 0.04
Nodes (23): APIRegistry, getNut(), ScreenAgent, callClaudeVision(), callOllamaVision(), VisionLoop, CommandGate, EvolutionAnalyzer (+15 more)

### Community 13 - "Community 13"
Cohesion: 0.06
Nodes (47): buildOpts(), mkAgent(), mkApprovalEngine(), mkDisplay(), mkPromptApi(), mkSessionManager(), mkSkillLoader(), mkSkinEngine() (+39 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (42): certificateLookup(), getSkill(), hostLookup(), hostSearch(), ApiSkill, RateLimiter, requireApiKey(), formatSubdomains() (+34 more)

### Community 15 - "Community 15"
Cohesion: 0.04
Nodes (16): fakeChatSessionCtor(), makeFakeBlessed(), makeOpts(), McpToolFilter, HttpTransport, StdioTransport, factory(), FakeSse (+8 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (27): ConversationMemory, getActiveGoalsSummary(), loadGoals(), appendRecord(), assignId(), _autoSummary(), _ensureDir(), loadAllRecords() (+19 more)

### Community 17 - "Community 17"
Cohesion: 0.07
Nodes (45): cmdAdd(), cmdDisable(), cmdEnable(), cmdList(), cmdLogs(), cmdRemove(), cmdRun(), cmdShow() (+37 more)

### Community 18 - "Community 18"
Cohesion: 0.05
Nodes (16): BM25, EntityGraph, hybridSearch(), normalise(), LearningMemory, applyMMR(), applyTemporalDecay(), SemanticMemory (+8 more)

### Community 19 - "Community 19"
Cohesion: 0.07
Nodes (33): boxBottom(), boxLine(), boxTop(), boxTopTitled(), truncateVisible(), visibleLength(), badgeForTier(), CliCallbacks (+25 more)

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (35): check_1_user_reported_leak(), check_2_code_block_safe(), check_3_unknown_tool(), check_4_malformed_json(), check_5_multiple(), check_6_mixed(), check_7_back_compat(), check_8_shape_edges() (+27 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (32): composeAuthorizeUrl(), defaultBuildAuthUrl(), generatePkce(), parseJsonOrThrow(), parseTokenResponse(), parseTokens(), postForTokens(), postWithTimeout() (+24 more)

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (19): AuxiliaryClient, callBgLLM(), getCerebrasKey(), getOllamaModel(), CostTracker, buildExtractionPrompt(), MemoryExtractor, memoryFilePath() (+11 more)

### Community 23 - "Community 23"
Cohesion: 0.07
Nodes (29): computeIdentity(), computeLevel(), computeProgress(), computeStreakDays(), computeTopStrength(), computeXP(), getIdentity(), loadIdentity() (+21 more)

### Community 24 - "Community 24"
Cohesion: 0.13
Nodes (22): main(), main(), main(), htmlReport(), main(), pickSuites(), main(), callAiden() (+14 more)

### Community 25 - "Community 25"
Cohesion: 0.09
Nodes (23): maskKey(), relativeTime(), renderFreeStatus(), renderProStatus(), createFeatureGate(), FeatureGate, isActivated(), isWellFormedKey() (+15 more)

### Community 26 - "Community 26"
Cohesion: 0.1
Nodes (29): assertHttps(), assertScriptExt(), assertSize(), extractSkillName(), fetchText(), importFromGitHub(), importFromLocal(), importFromUrl() (+21 more)

### Community 27 - "Community 27"
Cohesion: 0.07
Nodes (14): buildSdkRuntime(), buildSdkSurface(), getSdkMethods(), getSdkNamespaces(), callMcpTool(), connectMcpServer(), disconnectMcpServer(), listMcpServers() (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.09
Nodes (18): deliverBriefing(), generateBriefing(), loadBriefingConfig(), saveBriefingConfig(), detectPatterns(), getPatternSummary(), cancelReminder(), cronMatchesNow() (+10 more)

### Community 29 - "Community 29"
Cohesion: 0.1
Nodes (12): DeepKB, cleanText(), countWords(), extractEPUB(), extractFile(), extractPDF(), extractText(), chunkText() (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.11
Nodes (16): atomicWrite(), BundledManifest, sha256(), makeBundled(), skillFile(), copyDirRecursive(), detectBundledContentDrift(), dirExists() (+8 more)

### Community 31 - "Community 31"
Cohesion: 0.11
Nodes (23): analyzePatterns(), hasKeywordOverlap(), inferSkillName(), proposeDraft(), recordTask(), templateParams(), fetchIndex(), fetchSkillMarkdown() (+15 more)

### Community 32 - "Community 32"
Cohesion: 0.08
Nodes (5): messageToInput(), SessionManager, rowToSession(), sanitizeFtsQuery(), SessionStore

### Community 33 - "Community 33"
Cohesion: 0.16
Nodes (14): MockProviderAdapter, check_1_simple(), check_2_tool_turn(), check_3_multi_tool(), check_4_skill_prearm(), check_5_empty_response_retry(), check_6_fallback(), check_7_memory_dirty() (+6 more)

### Community 34 - "Community 34"
Cohesion: 0.12
Nodes (3): McpClient, FakeTransport, stdioFactory()

### Community 35 - "Community 35"
Cohesion: 0.12
Nodes (12): icon(), main(), printResult(), printSummary(), run(), runPart1(), runPart2(), runPart3() (+4 more)

### Community 36 - "Community 36"
Cohesion: 0.13
Nodes (14): UserCognitionProfile, classifyQueryForProfile(), clearHonchoProfile(), createUserProfile(), detectTimezone(), emptyHonchoProfile(), formatForPrompt(), getProfile() (+6 more)

### Community 37 - "Community 37"
Cohesion: 0.11
Nodes (3): ApprovalEngine, argSignature(), hostnameOf()

### Community 39 - "Community 39"
Cohesion: 0.25
Nodes (16): checkServer(), cleanupTestFiles(), fail(), httpGet(), main(), pass(), run(), runSection1() (+8 more)

### Community 42 - "Community 42"
Cohesion: 0.35
Nodes (13): check_1_pill_value_only(), check_2_pill_with_label(), check_3_banner(), check_4_startup_card_wide(), check_5_startup_card_narrow(), check_6_ansi_hygiene(), main(), makeDisplay() (+5 more)

### Community 44 - "Community 44"
Cohesion: 0.28
Nodes (13): classifyIssues(), dryRun(), estimatedCost(), main(), overBudget(), printBanner(), printSummaryTable(), printTopIssues() (+5 more)

### Community 45 - "Community 45"
Cohesion: 0.18
Nodes (5): Call-Aiden(), Log-TestResult(), Log-TestStart(), Invoke-Judge(), Run-QualityTest()

### Community 46 - "Community 46"
Cohesion: 0.24
Nodes (3): defaultBundledDir(), parseFrontmatter(), PersonalityManager

### Community 47 - "Community 47"
Cohesion: 0.23
Nodes (5): debugEnabled(), debugLog(), extractYoutubeIdsFromToolResult(), extractYoutubeWatchId(), UrlProvenanceTracker

### Community 48 - "Community 48"
Cohesion: 0.22
Nodes (3): BrowserVaultManager, loadPersistedBVaults(), savePersistedBVaults()

### Community 49 - "Community 49"
Cohesion: 0.53
Nodes (11): check_1_prompt_prefix(), check_2_agent_header(), check_3_turn_separator(), check_4_stream_header_parity(), check_5_composed_turn(), check_6_ansi_hygiene(), main(), makeDisplay() (+3 more)

### Community 50 - "Community 50"
Cohesion: 0.4
Nodes (4): diskHash(), ProtectedContextManager, readFirst(), sha1()

### Community 52 - "Community 52"
Cohesion: 0.22
Nodes (4): FakeAdapter, handler(), MockRegistry, schema()

### Community 60 - "Community 60"
Cohesion: 0.39
Nodes (7): ensureWorkspace(), playAudio(), _playUnix(), _playWindows(), recordAudio(), _recordUnix(), _recordWindows()

### Community 62 - "Community 62"
Cohesion: 0.31
Nodes (3): dockerBackendExecute(), isDockerAvailable(), localBackendExecute()

### Community 63 - "Community 63"
Cohesion: 0.39
Nodes (3): expandPath(), isFilesystemRoot(), isProtectedPath()

### Community 64 - "Community 64"
Cohesion: 0.33
Nodes (6): browserHeaders(), buildSearchUrl(), extractRunsText(), extractSimpleText(), fetchResultsPage(), harvestVideosFromInitialData()

### Community 67 - "Community 67"
Cohesion: 0.5
Nodes (7): chromeDebugArgs(), chromeDebugDataDir(), ensureCdpReady(), getChromeCandidatePaths(), getChromeCandidates(), probeCdp(), tryLaunchChromeDebug()

### Community 68 - "Community 68"
Cohesion: 0.32
Nodes (4): aidenVersion(), buildProvider(), register(), userAgentHeader()

### Community 70 - "Community 70"
Cohesion: 0.48
Nodes (6): checkTTSAvailable(), cleanForTTS(), ensureWorkspace(), speak(), speakEdgeTTS(), speakSAPI()

### Community 71 - "Community 71"
Cohesion: 0.43
Nodes (4): buildRequest(), classifyStatus(), networkErrorReason(), validateProviderKey()

### Community 72 - "Community 72"
Cohesion: 0.47
Nodes (3): checkScreenshots(), serverStatus(), status()

### Community 74 - "Community 74"
Cohesion: 0.47
Nodes (3): fetchJSON(), runAllTests(), test()

### Community 77 - "Community 77"
Cohesion: 0.6
Nodes (4): aidenVersion(), buildProvider(), register(), userAgentHeader()

### Community 78 - "Community 78"
Cohesion: 0.7
Nodes (4): Draw-Dashboard(), Format-Cost(), Get-ApiData(), Write-Section()

### Community 82 - "Community 82"
Cohesion: 0.83
Nodes (3): fetchJson(), recencyWeight(), socialResearch()

### Community 83 - "Community 83"
Cohesion: 0.83
Nodes (3): buildToolHandlers(), register(), resolveAidenRoot()

### Community 85 - "Community 85"
Cohesion: 0.83
Nodes (3): readSSE(), runStressTest(), runTest()

## Knowledge Gaps
- **3 isolated node(s):** `DevOSEventBus`, `DevOS / Aiden — Quick Action Hotkey Widget =====================================`, `Point`
  These have ≤1 connection - possible missing edges or undocumented components.
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `resolveAidenPaths()` connect `Community 0` to `Community 32`, `Community 2`, `Community 5`, `Community 41`, `Community 11`, `Community 19`, `Community 20`, `Community 21`, `Community 62`, `Community 25`, `Community 30`?**
  _High betweenness centrality (0.277) - this node is a cross-community bridge._
- **Why does `pwClose()` connect `Community 5` to `Community 1`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **Why does `handleCommand()` connect `Community 9` to `Community 1`, `Community 36`, `Community 8`, `Community 18`, `Community 27`?**
  _High betweenness centrality (0.164) - this node is a cross-community bridge._
- **Are the 26 inferred relationships involving `resolveAidenPaths()` (e.g. with `buildAgentRuntime()` and `runSetupSubcommand()`) actually correct?**
  _`resolveAidenPaths()` has 26 INFERRED edges - model-reasoned connections that need verification._
- **Are the 44 inferred relationships involving `summarize()` (e.g. with `groupA()` and `groupB()`) actually correct?**
  _`summarize()` has 44 INFERRED edges - model-reasoned connections that need verification._
- **Are the 28 inferred relationships involving `handleCommand()` (e.g. with `fg()` and `panel()`) actually correct?**
  _`handleCommand()` has 28 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DevOSEventBus`, `DevOS / Aiden — Quick Action Hotkey Widget =====================================`, `Point` to the rest of the system?**
  _3 weakly-connected nodes found - possible documentation gaps or missing edges._