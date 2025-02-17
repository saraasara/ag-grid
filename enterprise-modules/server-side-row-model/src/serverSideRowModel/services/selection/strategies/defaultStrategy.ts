import type {
    BeanCollection,
    IRowModel,
    IServerSideSelectionState,
    ISetNodesSelectedParams,
    RowNode,
    SelectionChangedEvent,
    SelectionEventSourceType,
    WithoutGridCommon,
} from '@ag-grid-community/core';
import { BeanStub, _errorOnce, _last, _warnOnce, isSelectionUIEvent } from '@ag-grid-community/core';

import { ServerSideRowRangeSelectionContext } from '../serverSideRowRangeSelectionContext';
import type { ISelectionStrategy } from './iSelectionStrategy';

interface SelectedState {
    selectAll: boolean;
    toggledNodes: Set<string>;
}

export class DefaultStrategy extends BeanStub implements ISelectionStrategy {
    private rowModel: IRowModel;
    private selectionCtx = new ServerSideRowRangeSelectionContext();

    public wireBeans(beans: BeanCollection) {
        this.rowModel = beans.rowModel;
    }

    private selectedState: SelectedState = { selectAll: false, toggledNodes: new Set() };

    private selectAllUsed: boolean = false;
    // this is to prevent regressions, default selectionService retains reference of clicked nodes.
    private selectedNodes: { [key: string]: RowNode } = {};

    private rowSelection?: 'single' | 'multiple';

    public postConstruct(): void {
        this.rowSelection = this.gos.get('rowSelection');
        this.addManagedPropertyListener('rowSelection', (propChange) => {
            this.rowSelection = propChange.currentValue;
        });
        this.selectionCtx.init(this.rowModel);
    }

    public getSelectedState(): IServerSideSelectionState {
        return {
            selectAll: this.selectedState.selectAll,
            toggledNodes: [...this.selectedState.toggledNodes],
        };
    }

    public setSelectedState(state: any) {
        // fire selection changed event
        const newState: SelectedState = {
            selectAll: false,
            toggledNodes: new Set(),
        };

        if (typeof state !== 'object') {
            _errorOnce('The provided selection state should be an object.');
            return;
        }

        if ('selectAll' in state && typeof state.selectAll === 'boolean') {
            newState.selectAll = state.selectAll;
        } else {
            _errorOnce('Select all status should be of boolean type.');
            return;
        }

        if ('toggledNodes' in state && Array.isArray(state.toggledNodes)) {
            state.toggledNodes.forEach((key: any) => {
                if (typeof key === 'string') {
                    newState.toggledNodes.add(key);
                } else {
                    _warnOnce(`Provided ids must be of string type. Invalid id provided: ${key}`);
                }
            });
        } else {
            _warnOnce('`toggledNodes` must be an array of string ids.');
            return;
        }

        this.selectedState = newState;
    }

    public deleteSelectionStateFromParent(parentPath: string[], removedNodeIds: string[]): boolean {
        if (this.selectedState.toggledNodes.size === 0) {
            return false;
        }

        let anyNodesToggled = false;

        removedNodeIds.forEach((id) => {
            if (this.selectedState.toggledNodes.delete(id)) {
                anyNodesToggled = true;
            }
        });

        return anyNodesToggled;
    }

    private overrideSelectionValue(newValue: boolean, source: SelectionEventSourceType): boolean {
        if (!isSelectionUIEvent(source)) {
            return newValue;
        }

        const root = this.selectionCtx.getRoot();
        const node = root ? this.rowModel.getRowNode(root) : null;

        return node ? node.isSelected() ?? false : true;
    }

    public setNodesSelected(params: ISetNodesSelectedParams): number {
        const { nodes, clearSelection, newValue, rangeSelect, source } = params;
        if (nodes.length === 0) return 0;

        const onlyThisNode = clearSelection && newValue && !rangeSelect;
        if (this.rowSelection !== 'multiple' || onlyThisNode) {
            if (nodes.length > 1) {
                throw new Error("AG Grid: cannot select multiple rows when rowSelection is set to 'single'");
            }
            const node = nodes[0];
            if (newValue) {
                this.selectedNodes = { [node.id!]: node };
                this.selectedState = {
                    selectAll: false,
                    toggledNodes: new Set([node.id!]),
                };
            } else {
                this.selectedNodes = {};
                this.selectedState = {
                    selectAll: false,
                    toggledNodes: new Set(),
                };
            }
            this.selectionCtx.reset(node.id!);
            return 1;
        }

        const updateNodeState = (node: RowNode, value = newValue) => {
            if (value) {
                this.selectedNodes[node.id!] = node;
            } else {
                delete this.selectedNodes[node.id!];
            }

            const isNodeSelectable = node.selectable;
            const doesNodeConform = value === this.selectedState.selectAll;
            if (doesNodeConform || !isNodeSelectable) {
                this.selectedState.toggledNodes.delete(node.id!);
                return;
            }
            this.selectedState.toggledNodes.add(node.id!);
        };

        if (rangeSelect) {
            if (nodes.length > 1) {
                throw new Error('AG Grid: cannot select multiple rows when using rangeSelect');
            }
            const node = nodes[0];
            const newSelectionValue = this.overrideSelectionValue(newValue, source);

            if (this.selectionCtx.isInRange(node.id!)) {
                const partition = this.selectionCtx.truncate(node.id!);

                // When we are selecting a range, we may need to de-select part of the previously
                // selected range (see AG-9620)
                // When we are de-selecting a range, we can/should leave the other nodes unchanged
                // (i.e. selected nodes outside the current range should remain selected - see AG-10215)
                if (newSelectionValue) {
                    partition.discard.forEach((node) => updateNodeState(node, false));
                }
                partition.keep.forEach((node) => updateNodeState(node, newSelectionValue));
            } else {
                const fromNode = this.selectionCtx.getRoot();
                const toNode = node;
                if (fromNode !== toNode.id) {
                    const partition = this.selectionCtx.extend(node.id!);
                    if (newSelectionValue) {
                        partition.discard.forEach((node) => updateNodeState(node, false));
                    }
                    partition.keep.forEach((node) => updateNodeState(node, newSelectionValue));
                }
            }
            return 1;
        }

        nodes.forEach((node) => updateNodeState(node));
        this.selectionCtx.reset(_last(nodes).id!);
        return 1;
    }

    public processNewRow(node: RowNode<any>): void {
        if (this.selectedNodes[node.id!]) {
            this.selectedNodes[node.id!] = node;
        }
    }

    public isNodeSelected(node: RowNode): boolean | undefined {
        const isToggled = this.selectedState.toggledNodes.has(node.id!);
        return this.selectedState.selectAll ? !isToggled : isToggled;
    }

    public getSelectedNodes(): RowNode<any>[] {
        if (this.selectAllUsed) {
            _warnOnce(
                `getSelectedNodes and getSelectedRows functions cannot be used with select all functionality with the server-side row model.
                Use \`api.getServerSideSelectionState()\` instead.`
            );
        }
        return Object.values(this.selectedNodes);
    }

    public getSelectedRows(): any[] {
        return this.getSelectedNodes().map((node) => node.data);
    }

    public getSelectionCount(): number {
        if (this.selectedState.selectAll) {
            return -1;
        }
        return this.selectedState.toggledNodes.size;
    }

    public clearOtherNodes(rowNodeToKeepSelected: RowNode<any>, source: SelectionEventSourceType): number {
        const clearedRows = this.selectedState.selectAll ? 1 : this.selectedState.toggledNodes.size - 1;
        this.selectedState = {
            selectAll: false,
            toggledNodes: new Set([rowNodeToKeepSelected.id!]),
        };

        this.rowModel.forEachNode((node) => {
            if (node !== rowNodeToKeepSelected) {
                node.selectThisNode(false, undefined, source);
            }
        });

        const event: WithoutGridCommon<SelectionChangedEvent> = {
            type: 'selectionChanged',
            source,
        };
        this.eventService.dispatchEvent(event);

        return clearedRows;
    }

    public isEmpty(): boolean {
        return !this.selectedState.selectAll && !this.selectedState.toggledNodes?.size;
    }

    public selectAllRowNodes(): void {
        this.selectedState = { selectAll: true, toggledNodes: new Set() };
        this.selectedNodes = {};
        this.selectAllUsed = true;
    }

    public deselectAllRowNodes(): void {
        this.selectedState = { selectAll: false, toggledNodes: new Set() };
        this.selectedNodes = {};
    }

    public getSelectAllState(): boolean | null {
        if (this.selectedState.selectAll) {
            if (this.selectedState.toggledNodes.size > 0) {
                return null;
            }
            return true;
        }

        if (this.selectedState.toggledNodes.size > 0) {
            return null;
        }
        return false;
    }
}
