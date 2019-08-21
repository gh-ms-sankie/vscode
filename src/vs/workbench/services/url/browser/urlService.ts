/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IURLService, IURLCreateOptions } from 'vs/platform/url/common/url';
import { URI, UriComponents } from 'vs/base/common/uri';
import { ServiceIdentifier, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { AbstractURLService } from 'vs/platform/url/common/urlService';
import { Event, Emitter } from 'vs/base/common/event';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { Disposable } from 'vs/base/common/lifecycle';
import { IRequestService } from 'vs/platform/request/common/request';
import { CancellationToken } from 'vs/base/common/cancellation';
import { streamToBuffer } from 'vs/base/common/buffer';
import { ILogService } from 'vs/platform/log/common/log';

export interface IURLCallbackProvider {

	readonly onCallback: Event<URI>;

	create(identifier: string, options?: IURLCreateOptions): URI;
}

export class BrowserURLService extends AbstractURLService {

	_serviceBrand!: ServiceIdentifier<any>;

	private provider: IURLCallbackProvider;

	constructor(
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();

		this.provider = environmentService.options && environmentService.options.urlCallbackProvider ? environmentService.options.urlCallbackProvider : instantiationService.createInstance(SelfhostURLCallbackProvider);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.provider.onCallback(uri => this.open(uri)));
	}

	create(identifier: string, options?: IURLCreateOptions): URI {
		return this.provider.create(identifier, options);
	}
}

class SelfhostURLCallbackProvider extends Disposable implements IURLCallbackProvider {

	static FETCH_INTERVAL = 500; 		// fetch every 500ms
	static FETCH_TIMEOUT = 1000 * 5; 	// ...but stop after 5min

	static QUERY_KEYS = {
		ID: 'vscode-id',
		PATH: 'vscode-path',
		QUERY: 'vscode-query',
		FRAGMENT: 'vscode-fragment'
	};

	private readonly _onCallback: Emitter<URI> = this._register(new Emitter<URI>());
	readonly onCallback: Event<URI> = this._onCallback.event;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	create(identifier: string, options?: IURLCreateOptions): URI {
		const { path, query, fragment } = options ? options : { path: undefined, query: undefined, fragment: undefined };

		const payload: Map<string, string> = new Map();
		if (path) {
			payload.set(SelfhostURLCallbackProvider.QUERY_KEYS.PATH, path);
		}

		if (query) {
			payload.set(SelfhostURLCallbackProvider.QUERY_KEYS.QUERY, query);
		}

		if (fragment) {
			payload.set(SelfhostURLCallbackProvider.QUERY_KEYS.FRAGMENT, fragment);
		}

		// Start to poll on the callback being fired (TODO@Ben optimize this, use management connection instead)
		this.periodicFetchCallback(identifier, Date.now());

		return this.doCreateUri(identifier, 'callback', payload);
	}

	private async periodicFetchCallback(identifier: string, startTime: number): Promise<void> {

		// Ask server for callback results
		const result = await this.requestService.request({
			url: this.doCreateUri(identifier, 'fetch-callback').toString(true)
		}, CancellationToken.None);

		// Check for callback results
		const content = await streamToBuffer(result.stream);
		if (content.byteLength > 0) {
			try {
				const uris: UriComponents[] = JSON.parse(content.toString());
				uris.forEach(uri => this._onCallback.fire(URI.revive(uri)));
			} catch (error) {
				this.logService.error(error);
			}

			return; // done
		}

		// Continue fetching unless we hit the timeout
		if (Date.now() - startTime < SelfhostURLCallbackProvider.FETCH_TIMEOUT) {
			setTimeout(() => this.periodicFetchCallback(identifier, startTime), SelfhostURLCallbackProvider.FETCH_INTERVAL);
		}
	}

	private doCreateUri(identifier: string, path: string, payload?: Map<string, string>): URI {
		let query = `${SelfhostURLCallbackProvider.QUERY_KEYS.ID}=${identifier}`;

		if (payload) {
			payload.forEach((value, key) => {
				query += `&${key}=${value}`;
			});
		}

		return URI.parse(window.location.href).with({ path, query });
	}
}

registerSingleton(IURLService, BrowserURLService, true);
