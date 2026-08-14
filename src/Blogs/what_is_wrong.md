
# What is wrong with current coding agent workflow

This was in early 2025 in which people believed that LLM models cannot code autonomously without ruining the code, let alone solving or creating the features. But the progress has been swift, and post claude opus 4.5 launch the world has largely changed its opinion about the ability of the LLM models to code or to write software precisely.

claude's latest models can mostly handle whatever is thrown at them and that too without much intervention from the human software engineer, these models don't require much instructions to work on any code base, they are coming ready from the factory. OpenAI and Anthropic have majorly invested in software development skill of the models, and most probably they will continue to do so. which leads us to an important and inevitable pivot in our coding agent workflow.

# What exists today

Github copilot came first, even before the LLM models came or were prevalent, I remember using it, it was mostly autocomplete. Even after the ChatGPT launch, people took some time to realize that these models are ok at coding too, github copilot was first to launch its copilot in a chat like fashion, which triggered the coding agent era, then followed windsurf (bought by cognition) and cursor, and some vibe coding apps (we will not talk about them in this article). The approach was clear, give the devs an IDE and a chat window with the coding agent, first it was ask only, which was good, since now we did not have to change our window for viewing some trivial information, tab completions also became good. Then as the LLM models continued to become better at not just coding but also reading and editing the files, they were specifically trained to use agentic tools, they became agents. Github copilot is used by a large number of devs because it is integrated with the most used IDEs VS code and VS. Better models came and now devs mostly complete their daily tasks (quite boring ones) with the agents, and it did quite a good job! we will also talk about cursor here, it is an AI IDE from ground up, and the integration of the editor with the Agent is really better than using VS code + github copilot, not only it is faster but more accurate.

Companies are buying subscriptions of copilot, cursor, kiro (Amazon IDE) or maybe Microsoft , cursor, amazon, cognition, are making deals with companies to get their product tested by their devs. I have heard numerous reports where in devs are being asked to use these tools and report how did it increase the productivity. I also use Copilot and cursor and i will agree that it is now doing 90% of my coding tasks, I have to tell properly what it has to do and it does it, the rest 10% are the cases wherein more that one repo is involved, or UI is involved (In-IDE agents can't use browsers yet!).

So now more or less we can say we are at an **individual model** of coding agent workflow (tasks are still assigned largely to the human devs), wherein the ticket(task) is assigned to the dev, he tells the agent what to do, and watches it do it in the opened tab, it takes maybe 10 minutes to do the edits, while the dev is relaxing (very seldom thinking on high level issues. LOL!), the agent has notified that the task is completed, the dev verifies the changes. And in the best case the PR is raised. In the worst case (which we will come to, that why this case arose!) the agent ruins all, and the dev either takes the task in its own hands, or retries asking the agent, until the agent reaches the 'aha!' moment.

whatever be the case, the economics of this **individual model** will not add up for your employer, why will he pay devs in full, and also manage to pay the AI help that they are getting? The inevitable will be to reduce the team size by half (at least!)

# What is wrong in the **individual model**

As the models are getting better, they are able to work autonomously for hours without the need to correct them (most often). Why not give them a complete sandbox environment to play? and the senior dev can verify the changes, most often the dev should verify if the functionality is working fine or not, and if test cases passed. So instead of assigning the tasks directly to the dev, he can be assigned with the peer review task, because his AI team member can produce code at inference speed, and once given all the tools like browser tools etc. it can most often produce the correct result and if you argue that it does not, it will certainly be true in another 6 months!

I call this model **Team model** of coding agent workflow.

# How we are working on this **Team model** for coding agent workflow

We started working on this **Team model** with the view that in future (near future) human devs will largely oversee the code written by AI agents, it will be the industrialization of the software industry! The Agent will not be seen as a helper but as a potential team member.

We started PhantomX to solve our issues, one day we were discussing on automating most of the software work in my previous company, the leadership wanted to create the tickets and assign to the agent and get the PR with little to no human intervention, we had some options, since we were majorly using github copilot, the team decided, to create a separate repository of organization level instructions and start some background tasks by feeding it the secrets and instructions, but a lot of things were manual in this workflow. Each dev would have to set its own environment for the agent, manually set the prompts, and this workspace cannot be shared across the organization!

This gave us an idea of an integrated app which will support the future of software development. since believe it or not, we are now moving away from **individual model**.

# Enters PhantomX

We created it for team collaboration from ground up! ensuring that each resource is only created once (by your senior developer) and can be accessed throughout the organization and teams.

These resources are:

1. Secrets

2. System Prompts

3. Workspaces

The workflow is intuitive and simple, you set the secrets and system prompts (shareable across the teams) and create a workspace template for one or more repositories, select which secrets and system prompts goes into the workspace, set the initial commands and the workspace is created, all one has to do now is to assign the tasks to this workspace.

We wanted to keep it highly autonomous, so you can start multiple tasks in background and review it, after you have reviewed the code, you can raise the PR. The tasks you created from the shared workspaces are private to you, but can be cloned by others if you allow. what is the gain? well for instance you don't have to configure the workspace again, if you are a senior dev or an engineering manager you can directly create a task from a pre-set workspace and start tasks right away.

Your devs need not look at their IDEs while the AI is working, rather they can use their AI integrated IDEs for complex tasks where we still require human intelligence. and use PhantomX for less complex tasks or complex tasks.

If you are a Product manager, you have to create a detailed jira or linear ticket, and assign to our agent (his name is Phantom!) and it will automatically break the task into smaller tasks and also start the tasks internally and raise the PR!

The performance of the agent is state of the art! we have included all the debugging tools, so our agent can work on full stack projects, and do everything that a human dev can do! We allow multiple repos in a workspace, so the agent has all the context it needs which further enhances the accuracy of the work done by the agent. everything gets executed in the secure remote environment.

We also included a full-fledged Editor with terminal and github tools for you to make changes on the go or debug with the agent, and you can stop the agent in mid task and guide it better if you think that it has taken a wrong direction. The agent can start your full stack apps and debug them properly, you can see the updates live made the agent in your web app, you don’t have to merge the PR or to use local environment to view the changes made by the agent.

We have been using this tool for 3 months now, and with more better models incoming we feel that this will be the new developer workflow for teams, where the agent will be seen as your co-worker and not just your private helper!

If you agree with this model, you can give PhantomX a try and help us and the world to find the most optimized workflow where we work together and better with the agents!