/**
 * The add-in's FunctionFile. The ribbon button only opens the task pane
 * (`ShowTaskpane`), so there are no functions to register; Office still
 * requires the page to load and initialize.
 */
if (typeof Office !== 'undefined') void Office.onReady();
