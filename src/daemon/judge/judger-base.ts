import { TestData, SubtaskScoringType, TestcaseJudge } from '../interfaces';
import { CompilationResult, JudgeResult, TaskStatus, SubtaskResult, TestcaseDetails, TestcaseResultType } from '../../interfaces';
import { Language } from '../../languages';
import { compile } from './compile';
import winston = require('winston');
import _ = require('lodash');

const globalFullScore = 100;
function calculateSubtaskScore(scoring: SubtaskScoringType, scores: number[]): number {
    if (scoring === SubtaskScoringType.Minimum) {
        return _.min(scores);
    } else if (scoring === SubtaskScoringType.Multiple) {
        return _.reduce(scores,
            (res, cur) => res * cur, 1);
    } else if (scoring === SubtaskScoringType.Summation) {
        return _.sum(scores) / scores.length;
    }
}

export abstract class JudgerBase {
    priority: number;
    testData: TestData;

    constructor(t: TestData, p: number) {
        this.priority = p;
        this.testData = t;
    }

    async preprocessTestData(): Promise<void> { }

    abstract compile(): Promise<CompilationResult>;

    async judge(reportProgressResult: (p: JudgeResult) => Promise<void>): Promise<JudgeResult> {
        const results: SubtaskResult[] = this.testData.subtasks.map(t => ({
            cases: t.cases.map(j => ({
                status: TaskStatus.Waiting,
                result: { scoringRate: t.type !== SubtaskScoringType.Summation ? 1 : 0 } as any
            })),
            status: TaskStatus.Waiting
        }));

        const updateSubtaskScore = (currentTask, currentResult) => {
            if (currentResult.cases.some(c => c.status === TaskStatus.Failed)) {
                // If any testcase has failed, the score is invaild.
                currentResult.score = NaN;
            } else {
                currentResult.score = calculateSubtaskScore(currentTask.type, currentResult.cases.map(c => c.result ? c.result.scoringRate : 0)) * currentTask.score;
            }
        }

        const testcaseDetailsCache: Map<string, TestcaseDetails> = new Map();
        const judgeTestcaseWrapper = async (curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails> => {
            if (testcaseDetailsCache.has(curCase.name)) {
                return testcaseDetailsCache.get(curCase.name);
            }

            const result: TestcaseDetails = await this.judgeTestcase(curCase, started);
            testcaseDetailsCache.set(curCase.name, result);

            return result;
        }

        for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; subtaskIndex++) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];
            updateSubtaskScore(currentTask, currentResult);
        }

        const reportProgress = function () {
            reportProgressResult({ subtasks: results });
        }
        winston.debug(`Totally ${results.length} subtasks.`);

        const judgeTasks: Promise<void>[] = [];
        /*let need:number[][]=[];
        let needNumber:number[]=[];
        for(let subtaskIndex=0;subtaskIndex<this.testData.subtasks.length;subtaskIndex++){
            needNumber.push(subtaskIndex);
            need.push([]);
            for(let index=0;index<subtaskIndex;index++){
                need[subtaskIndex].push(index);
            }
        }*/
        for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; subtaskIndex++) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];
            const updateCurrentSubtaskScore = () => updateSubtaskScore(currentTask, currentResult);
            let dependencyFail:boolean = false;
            if(currentTask.need !== undefined) {
				for(let index=0; index < currentTask.need.length; index++) {
					let dependencyIndex = currentTask.need[index] - 1;
					for (let caseIndex = 0; caseIndex < results[dependencyIndex].cases.length; caseIndex++) {
						if(results[dependencyIndex].cases[caseIndex].result.type !== TestcaseResultType.Accepted){
							results[subtaskIndex].score=0;
							dependencyFail = true;
							for (let taskIndex = 0; taskIndex < currentTask.cases.length; taskIndex++) {
								const currentTaskResult = currentResult.cases[taskIndex];
								currentTaskResult.status = TaskStatus.Skipped;
							}
							currentTask.score=0;
						}
					}
					//updateCurrentSubtaskScore();
				}
			}
			if(currentTask.dependency !== undefined) {
				for(let index = 0; index < currentTask.dependency.length; index++) {
					let dependencyIndex = currentTask.dependency[index] - 1;
					for (let caseIndex = 0; caseIndex < results[dependencyIndex].cases.length; caseIndex++) {
						if(results[dependencyIndex].cases[caseIndex].result.type !== TestcaseResultType.Accepted){
							results[subtaskIndex].score=0;
							dependencyFail = true;
							for (let taskIndex = 0; taskIndex < currentTask.cases.length; taskIndex++) {
								const currentTaskResult = currentResult.cases[taskIndex];
								currentTaskResult.status = TaskStatus.Skipped;
							}
							currentTask.score=0;
						}
					}
                //updateCurrentSubtaskScore();
         	   }
			}
            //winston.warn("subtask need check finish!");
			if(dependencyFail){
                updateCurrentSubtaskScore();
                await reportProgress();
                winston.verbose(`Subtask ${subtaskIndex}, finished`);
                continue;
            }
            //judgeTasks.push((async () => {
                // Type minimum is skippable, run one by one
                winston.warn("start running program...");
                if (currentTask.type !== SubtaskScoringType.Summation) {
                    let skipped: boolean = false;
                    for (let index = 0; index < currentTask.cases.length; index++) {
                        const currentTaskResult = currentResult.cases[index];
                        if (skipped) {
                            currentTaskResult.status = TaskStatus.Skipped;
                        } else {
                            winston.verbose(`Judging ${subtaskIndex}, case ${index}.`);
                            let score = 0;
                            try {
                                const taskJudge = await judgeTestcaseWrapper(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                                currentTaskResult.result = taskJudge;
                                score = taskJudge.scoringRate;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            if (score == null || isNaN(score) || score === 0) {
                                winston.debug(`Subtask ${subtaskIndex}, case ${index}: zero, skipping the rest.`);
                                skipped = true;
                            }
                            updateCurrentSubtaskScore();
                            await reportProgress();
                        }
                    }
                } else {
                    // Non skippable, run all immediately
                    //const caseTasks: Promise<void>[] = [];
                    for (let index = 0; index < currentTask.cases.length; index++) {
                        //caseTasks.push((async () => {
                            const currentTaskResult = currentResult.cases[index];
                            winston.warn(`Judging ${subtaskIndex}, case ${index}.`);
                            try {
                                currentTaskResult.result = await judgeTestcaseWrapper(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            updateCurrentSubtaskScore();
                            await reportProgress();
                        //})());
                    }
                    //await Promise.all(caseTasks);
                }
                updateCurrentSubtaskScore();
                winston.verbose(`Subtask ${subtaskIndex}, finished`);
            //})());
        }
        //await Promise.all(judgeTasks);
        return { subtasks: results };
    }
    protected abstract judgeTestcase(curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails>;

    async cleanup() { }
}
