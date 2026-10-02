import { ofetch } from 'ofetch';
import type { ApprovalProject, ProjectFilters } from '~/types/certification';
import { mockFetch } from './mock-fetch';
import { currentSnapshot, riskMatches } from './snapshots';

const client = ofetch.create({
  baseURL: '/api',
  retry: 0
}, {
  fetch: mockFetch as typeof fetch
});

function matches(project: ApprovalProject, filters: ProjectFilters) {
  const query = filters.query.trim().toLowerCase();
  const snapshot = currentSnapshot(project);
  const matchesQuery =
    !query ||
    [project.id, project.name, project.modelCode, snapshot.configuration, snapshot.softwareVersion]
      .join(' ')
      .toLowerCase()
      .includes(query);
  const matchesStatus = filters.status === 'all' || project.status === filters.status;
  const matchesAgency = filters.agency === 'all' || project.agency === filters.agency;
  const matchesRisk = riskMatches(project, filters.risk);

  return matchesQuery && matchesStatus && matchesAgency && matchesRisk;
}

export const certificationApi = {
  async listProjects(filters: ProjectFilters) {
    const projects = await client<ApprovalProject[]>('/projects');
    return projects.filter((project) => matches(project, filters));
  },

  async getProject(id: string) {
    return client<ApprovalProject>(`/projects/${encodeURIComponent(id)}`);
  }
};
