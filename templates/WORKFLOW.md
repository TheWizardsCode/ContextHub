## Workflow for AI Agents

It is expected that a session will be started by a human operator who will supply an initial prompt which defines the overall goals and context for the work to be done. When receiving such a prompt the agent will create an initial work-item in the worklog to track the work required to meet those goals. The work-item is created with a command such as `wl create "<work-item-title>" --description "<detailed-description-of-goals-and-context>" --issue-type <type-of-work-item> --json` (see [Work-Item Management](#work-item-management) below for more information). Remember the work-item id that is returnedm this will be referred to below as the <base-item-id>.

Once the item has been created the agent should display the outputs of `wl show <base-item-id> --format full` and confirm with the operator that the work-item accurately reflects the goals and context provided. If the operator requests changes to the work-item the agent should update the work-item description and acceptance criteria accordingly `wl update <id> --description "<updated-description>"`. DO NOT remove existing content unless it is incorrect, ONLY add to it with appropriate clarifications.

Once approved the agent should ask if they may ask further clarifying questions if required during the planning and implementation of <base-item-id>, the agent should make it clear that if the operator says no the agent will attempt to complete the task without further guidance, but being able to ask questions increases the chances of success. The agent will wait for confirmation from the operator before proceeding and remember the response.

The agent(s) will then plan and execute the work required to meet those goals by following the steps below.

0. **Claim the work-item** created by the operator:
   - Claim it with `wl update <id> --status in-progress --assignee @your-agent-name`
1. **Ensure the work-item is clearly defined**:
   - Review the description, acceptance criteria, and any related files/paths in the work item description and comments (retrieved with `wl show <id> --children --json`)
   - Review any existing work-items in the repository that may be related to this work-item (`wl search <search-terms> --json` and `wl show <id> --children --json`).
   - If the work-item is not clearly defined (it _MUST_ included a clear description of the goal and how it will change behaviour, preferably in the form of a user story, along with acceptance criteria that can be used to verify completion and references to important specifications, user-stories, designs, or other important context):
     - Search the worklog (`wl search <search-terms> --json` and `wl show <id> --children --json`) and repository for any existing information that may clarify the requirements
     - If the operator has allowed further questions ask for clarification on specific requirements, acceptance criteria, and context. Where possible provide suggested responses, but always allow for a free form text response.
     - If the operator has not allowed further questions attempt to clarify the requirements based on the existing information in the repository and worklog.
     - Update the work-item description and acceptance criteria with any clarifications found `wl update <id> --description "<updated-description>"`. DO NOT remove existing content unless it is incorrect, ONLY add to it with appropriate clarifications.
   - Once the work-item is clearly defined update its stage to `intake_complete` using `wl update <id> --stage intake_complete`
   - Report back to the operator summarising any clarifications made and proceed to the next step.
2. **Plan the work**:
   - Break down the work into smaller sub-tasks if necessary
   - Each sub-task should be a discrete unit of work that can be completed independently, if a sub-task is still too large break it down further with sub-tasks of its own
   - Verify and if possible improve the description of the goal and how it will change behaviour, preferably in the form of a user story
   - Verify and if possible improve the references to important specifications, user-stories, designs, or other important context
   - Verify and if possible improve the acceptance criteria so they are clear, measurable, and testable
   - Create child work-items for each sub-task using `wl create -t "<sub-task-title>" -d "<detailed-description>" --parent <base-item-id> --issue-type <type-of-work-item> --priority <critical|high|medium|low> --json`
   - Once planning is complete update the parent work-item stage to `plan_complete` using `wl update <base-item-id> --stage plan_complete`
   - Report back to the operator summarising the plan using `wl show <base-item-id> --children` and proceed to the next step.
3. **Decide what to work on next**:
   - Use `wl next --json` to get a recommendation for the next work-item to work on. The id of this item will be referred to below as <WIP-id>.
   - If the recommended work-item has no children proceed to the next step.
   - If the recommended work-item has children claim this work-item and mark it as in progress using `wl update <WIP-id> --status in-progress --assignee @your-agent-name`
   - Repeat this step to get the next recommended work-item until a leaf work-item (one with no children) is reached.
   - if there are no descendents of <base-item-id> left to work on go to the `End session` step.
   - Report back to the operator summarising the selected work-item and proceed to the next step.
4. **Implement the work-item**:
   - Review the content of the selected work-item
   - Review the description, acceptance criteria, and any related files/paths in the work item description and comments (retrieved with `wl show <WIP-id> --children --json`)
   - Review any existing work-items in the repository that may be related to this work-item (`wl search <search-terms> --json` and `wl show <id> --children --json`).
   - If the work-item is not clearly defined:
     - Search the worklog (`wl search <search-terms> --json` and `wl show <id> --children --json`) and repository for any existing information that may clarify the requirements
     - If the operator has allowed further questions ask for clarification on specific requirements, acceptance criteria, and context. Where possible provide suggested responses, but always allow for a free form text response.
     - If the operator has not allowed further questions attempt to clarify the requirements based on the existing information in the repository and worklog.
     - Update the work-item description and acceptance criteria with any clarifications found with `wl update <WIP-id> --description "<updated-description>"`. DO NOT remove existing content unless it is incorrect, ONLY add to it with appropriate clarifications.
   - Create a new branch for the work-item following the branch naming conventions (e.g. `wl-<WIP-id>-short-description`)
   - Complete all work required to meet the acceptance criteria (code, tests, documentation, etc.)
     - If new work-items are discovered during implementation create new work-items using `wl create "<work-item-title>" --description "<detailed-description-of-goals-and-context>" --issue-type <type-of-work-item> --json`. If the item must be completed in order to satisfy the requirements of the parent work-item, make the new item a child of the parent work-item using `--parent <parent-id>`. If it is an optional item make it a sibling of the <base-item-id> and add a reference to the base item in the description using `discovered-from:<base-item-id>`.
     - Regularly build and run all tests and checks to ensure nothing is broken
       - If the build or any tests/checks fail, fix the issues and repeat until all tests/checks pass
     - Commit changes whenever the Producer observes that a significant amount of progress has been made (ask if you think it is due), use clear commit messages that reference the WIP id and summarise the changes made.
   - If a particularly complex issue is identified or a significant design decisions or assumption is made record this in a comment on the work-item using `wl comment add <WIP-id> --comment "<detailed-comment>" --author @your-agent-name --json`
   - Once the acceptance criteria of <WIP-id> has been satisfied and all tests pass, Commit final changes to the branch with a message such as `<WIP-id>: Completed work to satisfy acceptance criteria: <acceptance-criteria-summary>`
   - When work is complete record a comment on the work-item summarising the changes made and the reason for them, including the commit hash using `wl comment add <id> --comment "Completed work, see commit <commit-hash> for details." --author @your-agent-name --json`
   - Update the work-item stage to `in_review` using `wl update <WIP-id> --stage in_review`
   - Report back to the operator summarising the work completed and proceed to the next step.
5. **Merge work into main**:
   - Update the branch to bring it into line with main
     - resolve any conflicts that arise
   - Build the application and run all tests and checks to ensure nothing is broken
     - If the build failes or any tests/checks fail, fix the issues and repeat until all tests/checks pass
   - Push the branch to the remote repository
   - Switch back to main, merge the branch and push the updated main branch to the remote repository
   - Close the work-item with a comment summarising the changes made and the reason for them, including the commit hash using `wl close <WIP-id> --reason "Completed work, see merge commit <merge-commit-hash> for details." --json`
   - Proceed to the next step.
6. **Update the operator**:
   - Provide the operator a summary of the work completed, including any relevant links (work-item id, commit hashes, PR links, etc.)
   - Do not suggest next steps at this point, simply report what has been done and proceed to the next step.
7. **Repeat**:
   - Go back to the `Decide what to work on next` step.
8. **End session**:
   - When there are no descendents of <base-item-id> left to work on, inform the operator that all required work is complete and summarize any discovered tasks, or pre-existing tasks in the worklog (`wl list --json`).
   - Ask the operator if they would like to address any of these remaining tasks now or if they would like to end the session.
   - If the operator wishes to address any remaining tasks, return to the `Claim the work-item` with the selected work-item id as the new <base-item-id>.
   - When the operator indicates that the session is complete, ensure all work-items created or worked on during the session are in the `in_review` or `done` stage.
   - Provide a final summary to the operator of all work completed during the session, including work-item ids, commit hashes, and any relevant links.
   - Thank the operator and end the session.
