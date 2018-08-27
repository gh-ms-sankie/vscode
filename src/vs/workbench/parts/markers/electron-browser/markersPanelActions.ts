/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from 'vs/base/common/async';
import * as DOM from 'vs/base/browser/dom';
import { TPromise } from 'vs/base/common/winjs.base';
import { Action, IAction } from 'vs/base/common/actions';
import { HistoryInputBox } from 'vs/base/browser/ui/inputbox/inputBox';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { IContextViewService, IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { TogglePanelAction } from 'vs/workbench/browser/panel';
import Messages from 'vs/workbench/parts/markers/electron-browser/messages';
import Constants from 'vs/workbench/parts/markers/electron-browser/constants';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { CollapseAllAction as TreeCollapseAction } from 'vs/base/parts/tree/browser/treeDefaults';
import * as Tree from 'vs/base/parts/tree/browser/tree';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { attachInputBoxStyler, attachStylerCallback, attachCheckboxStyler } from 'vs/platform/theme/common/styler';
import { IMarkersWorkbenchService } from 'vs/workbench/parts/markers/electron-browser/markers';
import { Event, Emitter } from 'vs/base/common/event';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { BaseActionItem, ActionItem } from 'vs/base/browser/ui/actionbar/actionbar';
import { badgeBackground, contrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { localize } from 'vs/nls';
import { Checkbox } from 'vs/base/browser/ui/checkbox/checkbox';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ContextScopedHistoryInputBox } from 'vs/platform/widget/browser/contextScopedHistoryWidget';
import { Marker } from 'vs/workbench/parts/markers/electron-browser/markersModel';
import { applyCodeAction } from 'vs/editor/contrib/codeAction/codeActionCommands';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IEditorService, ACTIVE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { isEqual } from 'vs/base/common/resources';

export class ToggleMarkersPanelAction extends TogglePanelAction {

	public static readonly ID = 'workbench.actions.view.problems';
	public static readonly LABEL = Messages.MARKERS_PANEL_TOGGLE_LABEL;

	constructor(id: string, label: string,
		@IPartService partService: IPartService,
		@IPanelService panelService: IPanelService,
		@IMarkersWorkbenchService markersWorkbenchService: IMarkersWorkbenchService
	) {
		super(id, label, Constants.MARKERS_PANEL_ID, panelService, partService);
	}
}

export class ShowProblemsPanelAction extends Action {

	public static readonly ID = 'workbench.action.problems.focus';
	public static readonly LABEL = Messages.MARKERS_PANEL_SHOW_LABEL;

	constructor(id: string, label: string,
		@IPanelService private panelService: IPanelService
	) {
		super(id, label);
	}

	public run(): TPromise<any> {
		return this.panelService.openPanel(Constants.MARKERS_PANEL_ID, true);
	}
}

export class CollapseAllAction extends TreeCollapseAction {

	constructor(viewer: Tree.ITree, enabled: boolean) {
		super(viewer, enabled);
	}
}

export class MarkersFilterAction extends Action {

	public static readonly ID: string = 'workbench.actions.problems.filter';

	constructor() {
		super(MarkersFilterAction.ID, Messages.MARKERS_PANEL_ACTION_TOOLTIP_FILTER, 'markers-panel-action-filter', true);
	}

}

export interface IMarkersFilterActionItemOptions {
	filterText: string;
	filterHistory: string[];
	useFilesExclude: boolean;
}

export class MarkersFilterActionItem extends BaseActionItem {

	private readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private delayedFilterUpdate: Delayer<void>;
	private container: HTMLElement;
	private filterContainer: HTMLElement;
	private filterInputBox: HistoryInputBox;
	private controlsContainer: HTMLInputElement;
	private filterBadge: HTMLInputElement;
	private filesExcludeFilter: Checkbox;

	constructor(
		itemOptions: IMarkersFilterActionItemOptions,
		action: IAction,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IContextViewService private contextViewService: IContextViewService,
		@IThemeService private themeService: IThemeService,
		@IMarkersWorkbenchService private markersWorkbenchService: IMarkersWorkbenchService,
		@ITelemetryService private telemetryService: ITelemetryService
	) {
		super(null, action);
		this.delayedFilterUpdate = new Delayer<void>(500);
		this.create(itemOptions);
	}

	render(container: HTMLElement): void {
		this.container = container;
		DOM.addClass(this.container, 'markers-panel-action-filter-container');
		DOM.append(this.container, this.filterContainer);
		this.adjustInputBox();
	}

	clear(): void {
		this.filterInputBox.value = '';
	}

	getFilterText(): string {
		return this.filterInputBox.value;
	}

	getFilterHistory(): string[] {
		return this.filterInputBox.getHistory();
	}

	get useFilesExclude(): boolean {
		return this.filesExcludeFilter.checked;
	}

	set useFilesExclude(useFilesExclude: boolean) {
		if (this.filesExcludeFilter.checked !== useFilesExclude) {
			this.filesExcludeFilter.checked = useFilesExclude;
			this._onDidChange.fire();
		}
	}

	toggleLayout(small: boolean) {
		if (this.container) {
			DOM.toggleClass(this.container, 'small', small);
		}
	}

	private create(itemOptions: IMarkersFilterActionItemOptions): void {
		this.filterContainer = DOM.$('.markers-panel-action-filter');
		this.createInput(this.filterContainer, itemOptions);
		this.createControls(this.filterContainer, itemOptions);
	}

	private createInput(container: HTMLElement, itemOptions: IMarkersFilterActionItemOptions): void {
		this.filterInputBox = this._register(this.instantiationService.createInstance(ContextScopedHistoryInputBox, container, this.contextViewService, {
			placeholder: Messages.MARKERS_PANEL_FILTER_PLACEHOLDER,
			ariaLabel: Messages.MARKERS_PANEL_FILTER_ARIA_LABEL,
			history: itemOptions.filterHistory
		}));
		this.filterInputBox.inputElement.setAttribute('aria-labelledby', 'markers-panel-arialabel');
		this._register(attachInputBoxStyler(this.filterInputBox, this.themeService));
		this.filterInputBox.value = itemOptions.filterText;
		this._register(this.filterInputBox.onDidChange(filter => this.delayedFilterUpdate.trigger(() => this.onDidInputChange())));
		this._register(DOM.addStandardDisposableListener(this.filterInputBox.inputElement, 'keydown', (keyboardEvent) => this.onInputKeyDown(keyboardEvent, this.filterInputBox)));
		this._register(DOM.addStandardDisposableListener(container, 'keydown', this.handleKeyboardEvent));
		this._register(DOM.addStandardDisposableListener(container, 'keyup', this.handleKeyboardEvent));
	}

	private createControls(container: HTMLElement, itemOptions: IMarkersFilterActionItemOptions): void {
		this.controlsContainer = DOM.append(container, DOM.$('.markers-panel-filter-controls'));
		this.createBadge(this.controlsContainer);
		this.createFilesExcludeCheckbox(this.controlsContainer, itemOptions);
	}

	private createBadge(container: HTMLElement): void {
		this.filterBadge = DOM.append(container, DOM.$('.markers-panel-filter-badge'));
		this._register(attachStylerCallback(this.themeService, { badgeBackground, contrastBorder }, colors => {
			const background = colors.badgeBackground ? colors.badgeBackground.toString() : null;
			const border = colors.contrastBorder ? colors.contrastBorder.toString() : null;

			this.filterBadge.style.backgroundColor = background;

			this.filterBadge.style.borderWidth = border ? '1px' : null;
			this.filterBadge.style.borderStyle = border ? 'solid' : null;
			this.filterBadge.style.borderColor = border;
		}));
		this.updateBadge();
		this._register(this.markersWorkbenchService.onDidChange(() => this.updateBadge()));
	}

	private createFilesExcludeCheckbox(container: HTMLElement, itemOptions: IMarkersFilterActionItemOptions): void {
		this.filesExcludeFilter = this._register(new Checkbox({
			actionClassName: 'markers-panel-filter-filesExclude',
			title: itemOptions.useFilesExclude ? Messages.MARKERS_PANEL_ACTION_TOOLTIP_DO_NOT_USE_FILES_EXCLUDE : Messages.MARKERS_PANEL_ACTION_TOOLTIP_USE_FILES_EXCLUDE,
			isChecked: itemOptions.useFilesExclude
		}));
		this._register(this.filesExcludeFilter.onChange(() => {
			this.filesExcludeFilter.domNode.title = this.filesExcludeFilter.checked ? Messages.MARKERS_PANEL_ACTION_TOOLTIP_DO_NOT_USE_FILES_EXCLUDE : Messages.MARKERS_PANEL_ACTION_TOOLTIP_USE_FILES_EXCLUDE;
			this._onDidChange.fire();
		}));

		this._register(attachCheckboxStyler(this.filesExcludeFilter, this.themeService));
		container.appendChild(this.filesExcludeFilter.domNode);
	}

	private onDidInputChange() {
		this.filterInputBox.addToHistory();
		this._onDidChange.fire();
		this.reportFilteringUsed();
	}

	private updateBadge(): void {
		const { total, filtered } = this.markersWorkbenchService.markersModel.stats();
		DOM.toggleClass(this.filterBadge, 'hidden', total === filtered || filtered === 0);
		this.filterBadge.textContent = localize('showing filtered problems', "Showing {0} of {1}", filtered, total);
		this.adjustInputBox();
	}

	private adjustInputBox(): void {
		this.filterInputBox.inputElement.style.paddingRight = (DOM.getTotalWidth(this.controlsContainer) || 20) + 'px';
	}

	// Action toolbar is swallowing some keys for action items which should not be for an input box
	private handleKeyboardEvent(e: IKeyboardEvent) {
		switch (e.keyCode) {
			case KeyCode.Space:
			case KeyCode.LeftArrow:
			case KeyCode.RightArrow:
			case KeyCode.Escape:
				e.stopPropagation();
				break;
		}
	}

	private onInputKeyDown(keyboardEvent: IKeyboardEvent, filterInputBox: HistoryInputBox) {
		let handled = false;
		switch (keyboardEvent.keyCode) {
			case KeyCode.Escape:
				filterInputBox.value = '';
				handled = true;
				break;
		}
		if (handled) {
			keyboardEvent.stopPropagation();
			keyboardEvent.preventDefault();
		}
	}

	private reportFilteringUsed(): void {
		let data = {};
		data['errors'] = this.markersWorkbenchService.markersModel.filterOptions.filterErrors;
		data['warnings'] = this.markersWorkbenchService.markersModel.filterOptions.filterWarnings;
		data['infos'] = this.markersWorkbenchService.markersModel.filterOptions.filterInfos;
		/* __GDPR__
			"problems.filter" : {
				"errors" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"warnings": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"infos": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
			}
		*/
		this.telemetryService.publicLog('problems.filter', data);
	}
}

export class QuickFixAction extends Action {

	public static readonly ID: string = 'workbench.actions.problems.quickfix';

	private updated: boolean = false;
	private disposables: IDisposable[] = [];

	constructor(
		readonly marker: Marker,
		@IBulkEditService private bulkEditService: IBulkEditService,
		@ICommandService private commandService: ICommandService,
		@IEditorService private editorService: IEditorService,
		@IModelService modelService: IModelService
	) {
		super(QuickFixAction.ID, Messages.MARKERS_PANEL_ACTION_TOOLTIP_QUICKFIX, 'markers-panel-action-quickfix', false);
		if (modelService.getModel(this.marker.resourceMarkers.uri)) {
			this.update();
		} else {
			modelService.onModelAdded(model => {
				if (isEqual(model.uri, marker.resource)) {
					this.update();
				}
			}, this, this.disposables);
		}

	}

	private update(): void {
		if (!this.updated) {
			this.marker.resourceMarkers.hasFixes(this.marker).then(hasFixes => this.enabled = hasFixes);
			this.updated = true;
		}
	}

	async getQuickFixActions(): Promise<IAction[]> {
		const codeActions = await this.marker.resourceMarkers.getFixes(this.marker);
		return codeActions.map(codeAction => new Action(
			codeAction.command ? codeAction.command.id : codeAction.title,
			codeAction.title,
			void 0,
			true,
			() => {
				return this.openFileAtMarker(this.marker)
					.then(() => applyCodeAction(codeAction, this.bulkEditService, this.commandService));
			}));
	}

	public openFileAtMarker(element: Marker): TPromise<void> {
		const { resource, selection } = { resource: element.resource, selection: element.range };
		return this.editorService.openEditor({
			resource,
			options: {
				selection,
				preserveFocus: true,
				pinned: false,
				revealIfVisible: true
			},
		}, ACTIVE_GROUP).then(() => null);
	}

	dispose(): void {
		dispose(this.disposables);
		super.dispose();
	}
}

export class QuickFixActionItem extends ActionItem {

	constructor(action: QuickFixAction,
		@IContextMenuService private contextMenuService: IContextMenuService
	) {
		super(null, action, { icon: true, label: false });
	}

	public onClick(event: DOM.EventLike): void {
		DOM.EventHelper.stop(event, true);
		const elementPosition = DOM.getDomNodePagePosition(this.element);
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: elementPosition.left + 10, y: elementPosition.top + elementPosition.height }),
			getActions: () => TPromise.wrap((<QuickFixAction>this.getAction()).getQuickFixActions()),
		});
	}

}