#import <CFNetwork/CFNetwork.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <unistd.h>

static NSString *const ZXDebugOrigin = @"https://debug-beta.zxlab.pages.dev";
static NSString *const ZXKeychainAccount = @"codex";
static NSString *const ZXProxyClientID = @"zxlab.debug-access.proxy.client-id";
static NSString *const ZXProxyClientSecret = @"zxlab.debug-access.proxy.client-secret";
static NSString *const ZXLegacyClientID = @"zxlab.debug-access.client-id";
static NSString *const ZXLegacyClientSecret = @"zxlab.debug-access.client-secret";
static NSUInteger const ZXMaximumResponseBytes = 1024 * 1024;

static NSError *ZXError(NSString *message) {
    return [NSError errorWithDomain:@"dev.zxlab.debug-access-proxy"
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey: message}];
}

static BOOL ZXBoundedMatch(NSString *value, NSString *pattern, NSUInteger maximum) {
    if (![value isKindOfClass:NSString.class] || value.length == 0 || [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maximum) return NO;
    NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil];
    return [expression firstMatchInString:value options:0 range:NSMakeRange(0, value.length)] != nil;
}

static NSString *ZXBoundedString(id value, NSUInteger maximum) {
    if (![value isKindOfClass:NSString.class]) return nil;
    NSString *string = value;
    if (string.length == 0 || [string lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maximum) return nil;
    return string;
}

static BOOL ZXNoArguments(NSArray<NSString *> *arguments, NSString *operation, NSError **error) {
    if (arguments.count == 0) return YES;
    if (error) *error = ZXError([NSString stringWithFormat:@"%@ does not accept arguments.", operation]);
    return NO;
}

static NSString *ZXRequiredFlag(NSArray<NSString *> *arguments, NSString *name, NSError **error) {
    if (arguments.count == 2 && [arguments[0] isEqualToString:name] && ![arguments[1] hasPrefix:@"--"]) return arguments[1];
    if (error) *error = ZXError([NSString stringWithFormat:@"%@ is required and no other arguments are allowed.", name]);
    return nil;
}

static NSDictionary *ZXParseOperation(NSArray<NSString *> *arguments, NSError **error) {
    NSString *command = arguments.firstObject ?: @"profile";
    NSArray<NSString *> *rest = arguments.count > 0 ? [arguments subarrayWithRange:NSMakeRange(1, arguments.count - 1)] : @[];
    NSSet<NSString *> *simple = [NSSet setWithArray:@[@"status", @"migrate", @"provision", @"profile", @"today", @"quality", @"watchlist-status", @"self-test"]];
    if ([simple containsObject:command]) {
        if (!ZXNoArguments(rest, command, error)) return nil;
        return @{ @"kind": command };
    }
    if ([command isEqualToString:@"run-create"]) {
        NSString *instrument = ZXRequiredFlag(rest, @"--instrument", error);
        if (!instrument) return nil;
        if (!ZXBoundedMatch(instrument, @"^[A-Z]{2,12}:[A-Z0-9._-]{1,32}$", 48)) {
            if (error) *error = ZXError(@"Instrument must use a bounded canonical identifier such as SSE:600000.");
            return nil;
        }
        return @{ @"kind": command, @"instrument": instrument };
    }
    if ([command isEqualToString:@"run-status"]) {
        NSString *runID = ZXRequiredFlag(rest, @"--run-id", error);
        if (!runID) return nil;
        if (!ZXBoundedMatch(runID, @"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", 128)) {
            if (error) *error = ZXError(@"Run ID is invalid.");
            return nil;
        }
        return @{ @"kind": command, @"runId": runID };
    }
    if (error) *error = ZXError(@"Unknown operation. Arbitrary methods, paths, bodies, and URLs are not supported.");
    return nil;
}

static NSData *ZXReadKeychainItem(NSString *service, OSStatus *statusOut) {
    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrAccount: ZXKeychainAccount,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
        (__bridge id)kSecReturnData: @YES,
    };
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (statusOut) *statusOut = status;
    if (status != errSecSuccess || result == NULL) {
        if (result) CFRelease(result);
        return nil;
    }
    return CFBridgingRelease(result);
}

static BOOL ZXWriteKeychainItem(NSString *service, NSData *data, NSError **error) {
    if (data.length == 0 || data.length > 512) {
        if (error) *error = ZXError(@"Credential input is empty or invalid.");
        return NO;
    }
    NSDictionary *selector = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrAccount: ZXKeychainAccount,
        (__bridge id)kSecAttrService: service,
    };
    OSStatus update = SecItemUpdate((__bridge CFDictionaryRef)selector,
                                    (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData: data});
    if (update == errSecSuccess) return YES;
    if (update != errSecItemNotFound) {
        if (error) *error = ZXError([NSString stringWithFormat:@"Keychain write failed with status %d.", (int)update]);
        return NO;
    }

    SecTrustedApplicationRef trusted = NULL;
    OSStatus trustedStatus = SecTrustedApplicationCreateFromPath(NULL, &trusted);
    if (trustedStatus != errSecSuccess || trusted == NULL) {
        if (error) *error = ZXError([NSString stringWithFormat:@"Keychain application binding failed with status %d.", (int)trustedStatus]);
        return NO;
    }
    SecAccessRef access = NULL;
    NSArray *trustedApplications = @[(__bridge id)trusted];
    OSStatus accessStatus = SecAccessCreate(CFSTR("ZXLab debug Access proxy"),
                                            (__bridge CFArrayRef)trustedApplications,
                                            &access);
    CFRelease(trusted);
    if (accessStatus != errSecSuccess || access == NULL) {
        if (error) *error = ZXError([NSString stringWithFormat:@"Keychain ACL creation failed with status %d.", (int)accessStatus]);
        return NO;
    }
    NSMutableDictionary *item = selector.mutableCopy;
    item[(__bridge id)kSecValueData] = data;
    item[(__bridge id)kSecAttrLabel] = service;
    item[(__bridge id)kSecAttrAccess] = (__bridge id)access;
    OSStatus add = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
    CFRelease(access);
    if (add != errSecSuccess) {
        if (error) *error = ZXError([NSString stringWithFormat:@"Keychain add failed with status %d.", (int)add]);
        return NO;
    }
    return YES;
}

static NSString *ZXCredentialString(NSString *service, NSError **error) {
    OSStatus status = errSecSuccess;
    NSData *data = ZXReadKeychainItem(service, &status);
    NSString *value = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    value = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!value || value.length == 0 || [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 512) {
        if (error) *error = ZXError([NSString stringWithFormat:@"Keychain access failed with status %d. Run migrate or provision in an interactive terminal.", (int)status]);
        return nil;
    }
    return value;
}

static NSDictionary *ZXKeychainStatus(void) {
    OSStatus clientStatus = errSecSuccess;
    OSStatus secretStatus = errSecSuccess;
    BOOL clientReadable = ZXReadKeychainItem(ZXProxyClientID, &clientStatus) != nil;
    BOOL secretReadable = ZXReadKeychainItem(ZXProxyClientSecret, &secretStatus) != nil;
    return @{
        @"ok": clientReadable && secretReadable ? @YES : @NO,
        @"clientIdReadable": clientReadable ? @YES : @NO,
        @"clientSecretReadable": secretReadable ? @YES : @NO,
    };
}

static NSData *ZXHiddenPrompt(const char *prompt, NSError **error) {
    if (!isatty(STDIN_FILENO)) {
        if (error) *error = ZXError(@"Provisioning requires an interactive terminal.");
        return nil;
    }
    char *value = getpass(prompt);
    if (!value) {
        if (error) *error = ZXError(@"Credential input failed.");
        return nil;
    }
    size_t length = strlen(value);
    if (length == 0 || length > 512) {
        if (error) *error = ZXError(@"Credential input is empty or invalid.");
        return nil;
    }
    return [NSData dataWithBytes:value length:length];
}

@interface ZXNoRedirectDelegate : NSObject <NSURLSessionTaskDelegate>
@end

@implementation ZXNoRedirectDelegate
- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *_Nullable))completionHandler {
    completionHandler(nil);
}
@end

static void ZXConfigureProxy(NSURLSessionConfiguration *configuration) {
    NSDictionary<NSString *, NSString *> *environment = NSProcessInfo.processInfo.environment;
    NSString *raw = environment[@"HTTPS_PROXY"] ?: environment[@"https_proxy"] ?: environment[@"ALL_PROXY"] ?: environment[@"all_proxy"];
    NSURL *proxy = raw ? [NSURL URLWithString:raw] : nil;
    if (!proxy.host || !proxy.port || proxy.user || proxy.password) return;
    if ([proxy.scheme isEqualToString:@"http"] || [proxy.scheme isEqualToString:@"https"]) {
        configuration.connectionProxyDictionary = @{
            (__bridge NSString *)kCFNetworkProxiesHTTPEnable: @YES,
            (__bridge NSString *)kCFNetworkProxiesHTTPProxy: proxy.host,
            (__bridge NSString *)kCFNetworkProxiesHTTPPort: proxy.port,
            (__bridge NSString *)kCFNetworkProxiesHTTPSEnable: @YES,
            (__bridge NSString *)kCFNetworkProxiesHTTPSProxy: proxy.host,
            (__bridge NSString *)kCFNetworkProxiesHTTPSPort: proxy.port,
        };
    } else if ([proxy.scheme isEqualToString:@"socks"] || [proxy.scheme isEqualToString:@"socks5"]) {
        configuration.connectionProxyDictionary = @{
            (__bridge NSString *)kCFNetworkProxiesSOCKSEnable: @YES,
            (__bridge NSString *)kCFNetworkProxiesSOCKSProxy: proxy.host,
            (__bridge NSString *)kCFNetworkProxiesSOCKSPort: proxy.port,
        };
    }
}

static NSDictionary *ZXRequestDefinition(NSDictionary *operation, NSError **error) {
    NSString *kind = operation[@"kind"];
    if ([kind isEqualToString:@"profile"]) return @{ @"method": @"GET", @"path": @"/api/private/market-agent/profile" };
    if ([kind isEqualToString:@"today"]) return @{ @"method": @"GET", @"path": @"/api/private/market-agent/today" };
    if ([kind isEqualToString:@"quality"]) return @{ @"method": @"GET", @"path": @"/api/private/market-agent/quality" };
    if ([kind isEqualToString:@"watchlist-status"]) return @{ @"method": @"GET", @"path": @"/api/private/market-agent/watchlist" };
    if ([kind isEqualToString:@"run-create"]) {
        NSDictionary *body = @{
            @"workflow": @"close_review",
            @"instrumentId": operation[@"instrument"],
            @"idempotencyKey": [NSString stringWithFormat:@"access-proxy:%@", NSUUID.UUID.UUIDString.lowercaseString],
        };
        NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:error];
        return data ? @{ @"method": @"POST", @"path": @"/api/private/market-agent/runs", @"body": data } : nil;
    }
    if ([kind isEqualToString:@"run-status"]) {
        return @{ @"method": @"GET", @"path": [@"/api/private/market-agent/runs/" stringByAppendingString:operation[@"runId"]] };
    }
    if (error) *error = ZXError(@"Operation does not map to a network request.");
    return nil;
}

static NSDictionary *ZXPerformRequest(NSDictionary *operation, NSString *clientID, NSString *clientSecret, NSError **error) {
    NSDictionary *definition = ZXRequestDefinition(operation, error);
    if (!definition) return nil;
    NSURL *origin = [NSURL URLWithString:ZXDebugOrigin];
    NSURL *url = [NSURL URLWithString:definition[@"path"] relativeToURL:origin].absoluteURL;
    if (![url.scheme isEqualToString:@"https"] || ![url.host isEqualToString:origin.host] ||
        ![url.path hasPrefix:@"/api/private/market-agent/"]) {
        if (error) *error = ZXError(@"Pinned destination validation failed.");
        return nil;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
                                                          cachePolicy:NSURLRequestReloadIgnoringLocalAndRemoteCacheData
                                                      timeoutInterval:15];
    request.HTTPMethod = definition[@"method"];
    request.HTTPBody = definition[@"body"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    [request setValue:clientID forHTTPHeaderField:@"CF-Access-Client-Id"];
    [request setValue:clientSecret forHTTPHeaderField:@"CF-Access-Client-Secret"];
    if (request.HTTPBody) [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
    configuration.HTTPShouldSetCookies = NO;
    configuration.HTTPAdditionalHeaders = @{ @"User-Agent": @"zxlab-access-proxy/1" };
    configuration.waitsForConnectivity = NO;
    ZXConfigureProxy(configuration);
    ZXNoRedirectDelegate *delegate = [ZXNoRedirectDelegate new];
    NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration delegate:delegate delegateQueue:nil];
    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block NSData *receivedData = nil;
    __block NSURLResponse *receivedResponse = nil;
    __block NSError *receivedError = nil;
    NSURLSessionDataTask *task = [session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *taskError) {
        receivedData = data;
        receivedResponse = response;
        receivedError = taskError;
        dispatch_semaphore_signal(semaphore);
    }];
    [task resume];
    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)) != 0) {
        [task cancel];
        [session invalidateAndCancel];
        if (error) *error = ZXError(@"The pinned debug request timed out.");
        return nil;
    }
    [session finishTasksAndInvalidate];
    if (receivedError || ![receivedResponse isKindOfClass:NSHTTPURLResponse.class] || !receivedData) {
        if (error) *error = ZXError(@"The pinned debug request failed.");
        return nil;
    }
    if (receivedData.length > ZXMaximumResponseBytes) {
        if (error) *error = ZXError(@"Response exceeded the one MiB safety limit.");
        return nil;
    }
    NSHTTPURLResponse *response = (NSHTTPURLResponse *)receivedResponse;
    return @{ @"status": @(response.statusCode), @"headers": response.allHeaderFields ?: @{}, @"data": receivedData };
}

static NSString *ZXResponseRequestID(NSDictionary *headers) {
    for (NSString *name in @[@"x-zx-request-id", @"x-request-id", @"cf-ray"]) {
        for (id key in headers) {
            if ([[key description].lowercaseString isEqualToString:name]) {
                NSString *value = ZXBoundedString(headers[key], 128);
                if (value && ZXBoundedMatch(value, @"^[A-Za-z0-9._:-]+$", 128)) return value;
            }
        }
    }
    return nil;
}

static NSString *ZXErrorCode(NSDictionary *payload) {
    id error = payload[@"error"];
    NSString *direct = ZXBoundedString(error, 96);
    if (direct) return direct;
    if ([error isKindOfClass:NSDictionary.class]) return ZXBoundedString(error[@"code"], 96);
    return nil;
}

static void ZXMergeRunSummary(NSDictionary *run, NSMutableDictionary *output) {
    NSString *runID = ZXBoundedString(run[@"id"] ?: run[@"runId"], 128);
    NSString *status = ZXBoundedString(run[@"status"], 32);
    NSString *workflow = ZXBoundedString(run[@"workflow"], 32);
    if (runID) output[@"runId"] = runID;
    if (status) output[@"runStatus"] = status;
    if (workflow) output[@"workflow"] = workflow;
    NSDictionary *result = [run[@"result"] isKindOfClass:NSDictionary.class] ? run[@"result"] : nil;
    NSDictionary *outcome = [result[@"outcome"] isKindOfClass:NSDictionary.class] ? result[@"outcome"] : nil;
    NSDictionary *narration = [outcome[@"narration"] isKindOfClass:NSDictionary.class] ? outcome[@"narration"] : nil;
    NSDictionary<NSString *, NSNumber *> *fields = @{
        @"source": @32, @"provider": @64, @"model": @128, @"gatewayRequestId": @128,
    };
    for (NSString *field in fields) {
        NSString *value = ZXBoundedString(narration[field], fields[field].unsignedIntegerValue);
        if (value) output[field] = value;
    }
    if ([narration[@"fallbackIndex"] isKindOfClass:NSNumber.class]) output[@"fallbackIndex"] = narration[@"fallbackIndex"];
}

static NSDictionary *ZXSummary(NSDictionary *operation, NSDictionary *result) {
    NSInteger status = [result[@"status"] integerValue];
    NSDictionary *headers = result[@"headers"];
    NSData *data = result[@"data"];
    id decoded = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *payload = [decoded isKindOfClass:NSDictionary.class] ? decoded : nil;
    NSMutableDictionary *output = [@{ @"ok": status >= 200 && status < 300 ? @YES : @NO, @"httpStatus": @(status) } mutableCopy];
    NSString *requestID = ZXResponseRequestID(headers);
    if (requestID) output[@"requestId"] = requestID;
    if (status < 200 || status >= 300) {
        output[@"errorCode"] = ZXErrorCode(payload) ?: [NSString stringWithFormat:@"HTTP_%ld", (long)status];
        if (status >= 300 && status < 400) output[@"redirected"] = @YES;
        return output;
    }
    NSString *kind = operation[@"kind"];
    if ([kind isEqualToString:@"profile"]) {
        NSString *bootstrap = ZXBoundedString(payload[@"bootstrap"], 32);
        if (bootstrap) output[@"bootstrap"] = bootstrap;
        output[@"watchlistConfigured"] = [payload[@"watchlistRevision"] isKindOfClass:NSString.class] ? @YES : @NO;
    } else if ([kind isEqualToString:@"today"]) {
        NSDictionary *run = [payload[@"run"] isKindOfClass:NSDictionary.class] ? payload[@"run"] : nil;
        output[@"hasRun"] = run != nil ? @YES : @NO;
        if (run) ZXMergeRunSummary(run, output);
    } else if ([kind isEqualToString:@"quality"]) {
        if ([payload[@"window"] isKindOfClass:NSNumber.class]) output[@"window"] = payload[@"window"];
        output[@"available"] = payload[@"metrics"] != nil ? @YES : @NO;
    } else if ([kind isEqualToString:@"watchlist-status"]) {
        NSDictionary *watchlist = [payload[@"watchlist"] isKindOfClass:NSDictionary.class] ? payload[@"watchlist"] : nil;
        NSArray *items = [watchlist[@"items"] isKindOfClass:NSArray.class] ? watchlist[@"items"] : nil;
        output[@"configured"] = watchlist != nil ? @YES : @NO;
        output[@"itemCount"] = @(items.count);
    } else if ([kind isEqualToString:@"run-create"]) {
        NSString *runID = ZXBoundedString(payload[@"runId"], 128);
        NSString *runStatus = ZXBoundedString(payload[@"status"], 32);
        if (runID) output[@"runId"] = runID;
        if (runStatus) output[@"runStatus"] = runStatus;
        if ([payload[@"created"] isKindOfClass:NSNumber.class]) output[@"created"] = payload[@"created"];
    } else if ([kind isEqualToString:@"run-status"]) {
        ZXMergeRunSummary(payload, output);
    }
    return output;
}

static BOOL ZXPrintJSON(NSDictionary *value, NSError **error) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:error];
    if (!data) return NO;
    NSString *string = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!string) {
        if (error) *error = ZXError(@"The proxy could not encode its safe output.");
        return NO;
    }
    puts(string.UTF8String);
    return YES;
}

static BOOL ZXRunSelfTest(NSError **error) {
    if (![[ZXParseOperation(@[], error) objectForKey:@"kind"] isEqualToString:@"profile"]) return NO;
    if (![[ZXParseOperation(@[@"run-create", @"--instrument", @"SSE:600000"], error) objectForKey:@"instrument"] isEqualToString:@"SSE:600000"]) return NO;
    if (ZXParseOperation(@[@"request", @"--url", @"https://example.com"], nil) != nil) return NO;
    if (ZXParseOperation(@[@"run-status", @"--run-id", @"../../secret"], nil) != nil) return NO;
    NSDictionary *fixture = @{
        @"id": @"run-1",
        @"status": @"success",
        @"result": @{ @"outcome": @{ @"narration": @{
            @"source": @"model", @"provider": @"deepseek", @"model": @"deepseek-v4-flash",
            @"fallbackIndex": @0, @"gatewayRequestId": @"gateway-1", @"summary": @"private text must not escape",
        }}},
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:fixture options:0 error:error];
    NSDictionary *summary = ZXSummary(@{ @"kind": @"run-status" }, @{ @"status": @200, @"headers": @{}, @"data": data });
    if (![summary[@"runId"] isEqualToString:@"run-1"] || ![summary[@"provider"] isEqualToString:@"deepseek"] || summary[@"summary"] != nil) {
        if (error) *error = ZXError(@"Native redaction self-test failed.");
        return NO;
    }
    return ZXPrintJSON(@{ @"ok": @YES, @"tests": @5 }, error);
}

static int ZXMain(NSArray<NSString *> *arguments) {
    NSError *error = nil;
    NSDictionary *operation = nil;
    NSDictionary *result = nil;
    NSDictionary *summary = nil;
    NSString *kind = nil;
    NSString *clientID = nil;
    NSString *clientSecret = nil;
    operation = ZXParseOperation(arguments, &error);
    if (!operation) goto fail;
    kind = operation[@"kind"];
    if ([kind isEqualToString:@"self-test"]) return ZXRunSelfTest(&error) ? EXIT_SUCCESS : EXIT_FAILURE;
    if ([kind isEqualToString:@"status"]) return ZXPrintJSON(ZXKeychainStatus(), &error) ? EXIT_SUCCESS : EXIT_FAILURE;
    if ([kind isEqualToString:@"migrate"]) {
        OSStatus clientStatus = errSecSuccess;
        OSStatus secretStatus = errSecSuccess;
        NSData *clientID = ZXReadKeychainItem(ZXLegacyClientID, &clientStatus);
        NSData *clientSecret = ZXReadKeychainItem(ZXLegacyClientSecret, &secretStatus);
        if (!clientID || !clientSecret) {
            error = ZXError([NSString stringWithFormat:@"Legacy Keychain access failed with status %d/%d. Use provision in an interactive terminal.", (int)clientStatus, (int)secretStatus]);
            goto fail;
        }
        if (!ZXWriteKeychainItem(ZXProxyClientID, clientID, &error) || !ZXWriteKeychainItem(ZXProxyClientSecret, clientSecret, &error)) goto fail;
        return ZXPrintJSON(@{ @"ok": @YES, @"migrated": @YES, @"legacyItemsRetained": @YES }, &error) ? EXIT_SUCCESS : EXIT_FAILURE;
    }
    if ([kind isEqualToString:@"provision"]) {
        NSData *clientID = ZXHiddenPrompt("Cloudflare Access Client ID: ", &error);
        NSData *clientSecret = clientID ? ZXHiddenPrompt("Cloudflare Access Client Secret: ", &error) : nil;
        NSData *confirmation = clientSecret ? ZXHiddenPrompt("Repeat Client Secret: ", &error) : nil;
        if (!clientID || !clientSecret || !confirmation) goto fail;
        if (![clientSecret isEqualToData:confirmation]) {
            error = ZXError(@"Client Secret confirmation did not match.");
            goto fail;
        }
        if (!ZXWriteKeychainItem(ZXProxyClientID, clientID, &error) || !ZXWriteKeychainItem(ZXProxyClientSecret, clientSecret, &error)) goto fail;
        return ZXPrintJSON(@{ @"ok": @YES, @"provisioned": @YES }, &error) ? EXIT_SUCCESS : EXIT_FAILURE;
    }

    clientID = ZXCredentialString(ZXProxyClientID, &error);
    clientSecret = clientID ? ZXCredentialString(ZXProxyClientSecret, &error) : nil;
    if (!clientID || !clientSecret) goto fail;
    result = ZXPerformRequest(operation, clientID, clientSecret, &error);
    if (!result) goto fail;
    summary = ZXSummary(operation, result);
    if (!ZXPrintJSON(summary, &error)) goto fail;
    return [summary[@"ok"] boolValue] ? EXIT_SUCCESS : EXIT_FAILURE;

fail:
    fprintf(stderr, "%s\n", (error.localizedDescription ?: @"ZXLab Access proxy failed.").UTF8String);
    return EXIT_FAILURE;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *arguments = [NSMutableArray array];
        for (int index = 1; index < argc; index += 1) [arguments addObject:@(argv[index])];
        return ZXMain(arguments);
    }
}
