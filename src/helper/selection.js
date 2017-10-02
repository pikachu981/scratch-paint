import paper from 'paper';
import Modes from '../modes/modes';

import {getItemsGroup, isGroup} from './group';
import {getRootItem, isCompoundPathItem, isBoundsItem, isPathItem, isPGTextItem} from './item';
import {getItemsCompoundPath, isCompoundPath, isCompoundPathChild} from './compound-path';

/**
 * @param {boolean} includeGuides True if guide layer items like the bounding box should
 *     be included in the returned items.
 * @return {Array<paper.item>} all top-level (direct descendants of a paper.Layer) items
 */
const getAllPaperItems = function (includeGuides) {
    includeGuides = includeGuides || false;
    const allItems = [];
    for (const layer of paper.project.layers) {
        for (const child of layer.children) {
            // don't give guides back
            if (!includeGuides && child.guide) {
                continue;
            }
            allItems.push(child);
        }
    }
    return allItems;
};

/**
 * @return {Array<paper.item>} all top-level (direct descendants of a paper.Layer) items
 *     that aren't guide items or helper items.
 */
const getAllSelectableItems = function () {
    const allItems = getAllPaperItems();
    const selectables = [];
    for (let i = 0; i < allItems.length; i++) {
        if (allItems[i].data && !allItems[i].data.isHelperItem) {
            selectables.push(allItems[i]);
        }
    }
    return selectables;
};

const selectItemSegments = function (item, state) {
    if (item.children) {
        for (let i = 0; i < item.children.length; i++) {
            const child = item.children[i];
            if (child.children && child.children.length > 0) {
                selectItemSegments(child, state);
            } else {
                child.fullySelected = state;
            }
        }
    } else {
        for (let i = 0; i < item.segments.length; i++) {
            item.segments[i].selected = state;
        }
    }
};

const setGroupSelection = function (root, selected, fullySelected) {
    root.fullySelected = fullySelected;
    root.selected = selected;
    // select children of compound-path or group
    if (isCompoundPath(root) || isGroup(root)) {
        const children = root.children;
        if (children) {
            for (const child of children) {
                if (isGroup(child)) {
                    setGroupSelection(child, selected, fullySelected);
                } else {
                    child.fullySelected = fullySelected;
                    child.selected = selected;
                }
            }
        }
    }
};

const setItemSelection = function (item, state, fullySelected) {
    const parentGroup = getItemsGroup(item);
    const itemsCompoundPath = getItemsCompoundPath(item);
    
    // if selection is in a group, select group
    if (parentGroup) {
        // do it recursive
        setItemSelection(parentGroup, state, fullySelected);
    } else if (itemsCompoundPath) {
        setGroupSelection(itemsCompoundPath, state, fullySelected);
    } else {
        if (item.data && item.data.noSelect) {
            return;
        }
        setGroupSelection(item, state, fullySelected);
    }
    // @todo: Update toolbar state on change
    
};

const selectAllItems = function () {
    const items = getAllSelectableItems();
    
    for (let i = 0; i < items.length; i++) {
        setItemSelection(items[i], true);
    }
};

const selectAllSegments = function () {
    const items = getAllSelectableItems();
    
    for (let i = 0; i < items.length; i++) {
        selectItemSegments(items[i], true);
    }
};

/** @param {!function} dispatchClearSelect Function to update the Redux select state */
const clearSelection = function (dispatchClearSelect) {
    paper.project.deselectAll();
    // @todo: Update toolbar state on change
    dispatchClearSelect();
};

// This gets all selected non-grouped items and groups
// (alternative to paper.project.selectedItems, which includes
// group children in addition to the group)
// Returns in increasing Z order
const getSelectedItems = function (recursive) {
    const allItems = paper.project.selectedItems;
    const itemsAndGroups = [];

    if (recursive) {
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            if (item.data && !item.data.isSelectionBound) {
                itemsAndGroups.push(item);
            }
        }
    } else {
        for (let i = 0; i < allItems.length; i++) {
            const item = allItems[i];
            if ((isGroup(item) && !isGroup(item.parent)) ||
                    !isGroup(item.parent)) {
                if (item.data && !item.data.isSelectionBound) {
                    itemsAndGroups.push(item);
                }
            }
        }
    }
    // sort items by index (0 at bottom)
    itemsAndGroups.sort((a, b) => parseFloat(a.index) - parseFloat(b.index));
    return itemsAndGroups;
};

const deleteItemSelection = function (recursive) {
    const items = getSelectedItems(recursive);
    for (let i = 0; i < items.length; i++) {
        items[i].remove();
    }
    
    // @todo: Update toolbar state on change
    paper.project.view.update();
    // @todo add back undo
    // pg.undo.snapshot('deleteItemSelection');
};

const removeSelectedSegments = function (recursive) {
    // @todo add back undo
    // pg.undo.snapshot('removeSelectedSegments');
    
    const items = getSelectedItems(recursive);
    const segmentsToRemove = [];
    
    for (let i = 0; i < items.length; i++) {
        const segments = items[i].segments;
        for (let j = 0; j < segments.length; j++) {
            const seg = segments[j];
            if (seg.selected) {
                segmentsToRemove.push(seg);
            }
        }
    }
    
    let removedSegments = false;
    for (let i = 0; i < segmentsToRemove.length; i++) {
        const seg = segmentsToRemove[i];
        seg.remove();
        removedSegments = true;
    }
    return removedSegments;
};

const deleteSelection = function (mode) {
    if (mode === Modes.RESHAPE) {
        // If there are points selected remove them. If not delete the item selected.
        if (!removeSelectedSegments(true /* recursive */)) {
            deleteItemSelection(true /* recursive */);
        }
    } else {
        deleteItemSelection();
    }
};

const splitPathRetainSelection = function (path, index, deselectSplitSegments) {
    const selectedPoints = [];
    
    // collect points of selected segments, so we can reselect them
    // once the path is split.
    for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i];
        if (seg.selected) {
            if (deselectSplitSegments && i === index) {
                continue;
            }
            selectedPoints.push(seg.point);
        }
    }
    
    const newPath = path.split(index, 0);
    if (!newPath) return;
    
    // reselect all of the newPaths segments that are in the exact same location
    // as the ones that are stored in selectedPoints
    for (let i = 0; i < newPath.segments.length; i++) {
        const seg = newPath.segments[i];
        for (let j = 0; j < selectedPoints.length; j++) {
            const point = selectedPoints[j];
            if (point.x === seg.point.x && point.y === seg.point.y) {
                seg.selected = true;
            }
        }
    }
    
    // only do this if path and newPath are different
    // (split at more than one point)
    if (path !== newPath) {
        for (let i = 0; i < path.segments.length; i++) {
            const seg = path.segments[i];
            for (let j = 0; j < selectedPoints.length; j++) {
                const point = selectedPoints[j];
                if (point.x === seg.point.x && point.y === seg.point.y) {
                    seg.selected = true;
                }
            }
        }
    }
};

const splitPathAtSelectedSegments = function () {
    const items = getSelectedItems();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const segments = item.segments;
        for (let j = 0; j < segments.length; j++) {
            const segment = segments[j];
            if (segment.selected) {
                if (item.closed ||
                    (segment.next &&
                    !segment.next.selected &&
                    segment.previous &&
                    !segment.previous.selected)) {
                    splitPathRetainSelection(item, j, true);
                    splitPathAtSelectedSegments();
                    return;
                }
            }
        }
    }
};

const deleteSegments = function (item) {
    if (item.children) {
        for (let i = 0; i < item.children.length; i++) {
            const child = item.children[i];
            deleteSegments(child);
        }
    } else {
        const segments = item.segments;
        for (let j = 0; j < segments.length; j++) {
            const segment = segments[j];
            if (segment.selected) {
                if (item.closed ||
                    (segment.next &&
                    !segment.next.selected &&
                    segment.previous &&
                    !segment.previous.selected)) {

                    splitPathRetainSelection(item, j);
                    deleteSelection();
                    return;

                } else if (!item.closed) {
                    segment.remove();
                    j--; // decrease counter if we removed one from the loop
                }

            }
        }
    }
    // remove items with no segments left
    if (item.segments.length <= 0) {
        item.remove();
    }
};

const deleteSegmentSelection = function () {
    
    const items = getSelectedItems();
    for (let i = 0; i < items.length; i++) {
        deleteSegments(items[i]);
    }

    // @todo: Update toolbar state on change
    paper.project.view.update();
    // @todo add back undo
    // pg.undo.snapshot('deleteSegmentSelection');
};

const cloneSelection = function (recursive) {
    const selectedItems = getSelectedItems(recursive);
    for (let i = 0; i < selectedItems.length; i++) {
        const item = selectedItems[i];
        item.clone();
        item.selected = false;
    }
    // @todo add back undo
    // pg.undo.snapshot('cloneSelection');
};

// Only returns paths, no compound paths, groups or any other stuff
const getSelectedPaths = function () {
    const allPaths = getSelectedItems();
    const paths = [];

    for (let i = 0; i < allPaths.length; i++) {
        const path = allPaths[i];
        if (path.className === 'Path') {
            paths.push(path);
        }
    }
    return paths;
};

const checkBoundsItem = function (selectionRect, item, event) {
    const itemBounds = new paper.Path([
        item.localToGlobal(item.internalBounds.topLeft),
        item.localToGlobal(item.internalBounds.topRight),
        item.localToGlobal(item.internalBounds.bottomRight),
        item.localToGlobal(item.internalBounds.bottomLeft)
    ]);
    itemBounds.closed = true;
    itemBounds.guide = true;

    for (let i = 0; i < itemBounds.segments.length; i++) {
        const seg = itemBounds.segments[i];
        if (selectionRect.contains(seg.point) ||
            (i === 0 && selectionRect.getIntersections(itemBounds).length > 0)) {
            if (event.modifiers.shift && item.selected) {
                setItemSelection(item, false);

            } else {
                setItemSelection(item, true);
            }
            itemBounds.remove();
            return true;
            
        }
    }

    itemBounds.remove();
};

const _handleRectangularSelectionItems = function (item, event, rect, mode, root) {
    if (isPathItem(item)) {
        let segmentMode = false;
        
        // first round checks for segments inside the selectionRect
        for (let j = 0; j < item.segments.length; j++) {
            const seg = item.segments[j];
            if (rect.contains(seg.point)) {
                if (mode === Modes.RESHAPE) {
                    if (event.modifiers.shift && seg.selected) {
                        seg.selected = false;
                    } else {
                        seg.selected = true;
                    }
                    segmentMode = true;
                } else {
                    if (event.modifiers.shift && item.selected) {
                        setItemSelection(root, false);
                    } else {
                        setItemSelection(root, true, true /* fullySelected */);
                    }
                    return false;
                }
            }
        }

        // second round checks for path intersections
        const intersections = item.getIntersections(rect);
        if (intersections.length > 0 && !segmentMode) {
            // if in reshape mode, select the curves that intersect
            // with the selectionRect
            if (mode === Modes.RESHAPE) {
                for (let k = 0; k < intersections.length; k++) {
                    const curve = intersections[k].curve;
                    // intersections contains every curve twice because
                    // the selectionRect intersects a circle always at
                    // two points. so we skip every other curve
                    if (k % 2 === 1) {
                        continue;
                    }

                    if (event.modifiers.shift) {
                        curve.selected = !curve.selected;
                    } else {
                        curve.selected = true;
                    }
                }
            } else {
                if (event.modifiers.shift && item.selected) {
                    setItemSelection(item, false);

                } else {
                    setItemSelection(item, true);
                }
                return false;
            }
        }
        // @todo: Update toolbar state on change

    } else if (isBoundsItem(item)) {
        if (checkBoundsItem(rect, item, event)) {
            return false;
        }
    }
    return true;
};

// if the rectangular selection found a group, drill into it recursively
const _rectangularSelectionGroupLoop = function (group, rect, root, event, mode) {
    for (let i = 0; i < group.children.length; i++) {
        const child = group.children[i];
        
        if (isGroup(child) || isCompoundPathItem(child)) {
            _rectangularSelectionGroupLoop(child, rect, root, event, mode);
        } else {
            _handleRectangularSelectionItems(child, event, rect, mode, root);
        }
    }
    return true;
};

/**
 * Called after drawing a selection rectangle in a select mode. In reshape mode, this
 * selects all control points and curves within the rectangle. In select mode, this
 * selects all items and groups that intersect the rectangle
 * @param {!MouseEvent} event The mouse event to draw the rectangle
 * @param {!paper.Rect} rect The selection rectangle
 * @param {Modes} mode The mode of the paint editor when drawing the rectangle
 */
const processRectangularSelection = function (event, rect, mode) {
    const allItems = getAllSelectableItems();
    
    for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        if (mode === Modes.RESHAPE && isPGTextItem(getRootItem(item))) {
            continue;
        }
        if (isGroup(item) || isCompoundPathItem(item)) {
            // check for item segment points inside
            _rectangularSelectionGroupLoop(item, rect, item, event, mode);
        } else {
            _handleRectangularSelectionItems(item, event, rect, mode, item);
        }
    }
};

/**
 * When switching to the select tool while having a child object of a
 * compound path selected, deselect the child and select the compound path
 * instead. (otherwise the compound path breaks because of scale-grouping)
 */
const selectRootItem = function () {
    const items = getSelectedItems(true /* recursive */);
    for (const item of items) {
        if (isCompoundPathChild(item)) {
            const cp = getItemsCompoundPath(item);
            setItemSelection(cp, true, true /* fullySelected */);
        }
        const rootItem = getRootItem(item);
        if (item !== rootItem) {
            setItemSelection(rootItem, true, true /* fullySelected */);
        }
    }
};

const shouldShowIfSelection = function () {
    return getSelectedItems().length > 0;
};

const shouldShowIfSelectionRecursive = function () {
    return getSelectedItems(true /* recursive */).length > 0;
};

const shouldShowSelectAll = function () {
    return paper.project.getItems({class: paper.PathItem}).length > 0;
};

export {
    getAllPaperItems,
    selectAllItems,
    selectAllSegments,
    clearSelection,
    deleteSelection,
    deleteItemSelection,
    deleteSegmentSelection,
    splitPathAtSelectedSegments,
    cloneSelection,
    setItemSelection,
    setGroupSelection,
    getSelectedItems,
    getSelectedPaths,
    removeSelectedSegments,
    processRectangularSelection,
    selectRootItem,
    shouldShowIfSelection,
    shouldShowIfSelectionRecursive,
    shouldShowSelectAll
};
